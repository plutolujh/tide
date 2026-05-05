/**
 * Multi-Source RSS Sync → Supabase blog_posts
 * Sources: HN, TechCrunch, The Verge, Ars Technica
 * Bilingual: English + Chinese titles and AI summaries
 *
 * Usage: node sync-all.js [count] [--loop=hours] [--source=hn|tc|verge|ars|all]
 *
 * Providers:
 * - SUMMARIZER_PROVIDER: minimax/doubao for summarizing articles
 * - TRANSLATOR_PROVIDER: minimax/doubao/both for translation
 * - JUDGE_PROVIDER: deepseek to score translations and determine winners
 */

import { createProvider } from './providers/index.js';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sourcesConfig = require('./sources.json');

// Build flattened SOURCES map from groups config
const SOURCES = {};
const GROUPS = {};

for (const [groupKey, group] of Object.entries(sourcesConfig.groups)) {
  if (!group.enabled) continue;
  GROUPS[groupKey] = {
    name: group.name,
    nameEn: group.nameEn,
    categoryId: group.categoryId,
    sortOrder: group.sortOrder,
    syncIntervalHours: group.syncIntervalHours
  };
  for (const [sourceKey, source] of Object.entries(group.sources)) {
    SOURCES[sourceKey] = {
      name: source.name,
      tag: sourceKey,
      category_id: group.categoryId,
      rssUrl: source.rssUrl,
      scrapeUrl: source.scrapeUrl,
      parseFn: source.parseFn
    };
  }
}

const LOG_DIR = './logs';

function getLogFile() {
  return `${LOG_DIR}/sync-all-${new Date().toISOString().slice(0, 10)}.log`;
}

function log(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    appendFileSync(getLogFile(), line + '\n');
  } catch (e) {
    console.error('Failed to write log:', e.message);
  }
}

const env = {};
readFileSync('.env', 'utf8').split('\n').forEach(line => {
  const idx = line.indexOf('=');
  if (idx > 0) {
    const key = line.substring(0, idx).trim();
    const val = line.substring(idx + 1).trim();
    env[key] = val;
  }
});
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_KEY;

// Provider configuration
const SUMMARIZER_PROVIDER = env.SUMMARIZER_PROVIDER || 'minimax';
const TRANSLATOR_PROVIDER = env.TRANSLATOR_PROVIDER || 'minimax';
const JUDGE_PROVIDER = env.JUDGE_PROVIDER || 'deepseek';

const JINA_API_URL = 'https://r.jina.ai/';

const ANON_KEY = SUPABASE_KEY;
const HN_API = 'https://hn.algolia.com/api/v1';

// ---------- Fetch with retry ----------
async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok && res.status >= 500 && i < retries - 1) {
        log(`  [retry] ${res.status} from ${url}, attempt ${i + 1}/${retries}`);
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      if (i < retries - 1) {
        log(`  [retry] ${err.message}, attempt ${i + 1}/${retries}`);
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      } else {
        throw err;
      }
    }
  }
}

// ---------- Parse RSS/Atom ----------
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const titleMatch = item.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = item.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const descMatch = item.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description[^>]*>([\s\S]*?)<\/description>/i);

    let title = titleMatch ? (titleMatch[1] || titleMatch[2] || '').trim() : '';
    let link = linkMatch ? linkMatch[1].trim().replace(/<[^>]+>/g, '') : '';
    const desc = descMatch ? (descMatch[1] || descMatch[2] || '').trim() : '';

    if (title && link) {
      items.push({ title, url: link, desc });
    }
  }
  return items;
}

function parseAtom(xml) {
  const items = [];
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const titleMatch = entry.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*>|<link[^>]*>([\s\S]*?)<\/link>/i);
    const summaryMatch = entry.match(/<summary[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/summary>|<summary[^>]*>([\s\S]*?)<\/summary>/i);
    const contentMatch = entry.match(/<content[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/content>|<content[^>]*>([\s\S]*?)<\/content>/i);

    let title = titleMatch ? (titleMatch[1] || titleMatch[2] || '').trim() : '';
    let link = linkMatch ? (linkMatch[1] || linkMatch[2] || '').trim().replace(/<[^>]+>/g, '') : '';
    const desc = summaryMatch ? (summaryMatch[1] || summaryMatch[2] || '').trim() : ''
              || contentMatch ? (contentMatch[1] || contentMatch[2] || '').trim() : '';

    if (title && link) {
      items.push({ title, url: link, desc });
    }
  }
  return items;
}

// ---------- Fetch stories from RSS ----------
async function fetchRSS(source, count = 5) {
  const cfg = SOURCES[source];
  if (!cfg || !cfg.rssUrl) return [];

  const res = await fetchWithRetry(cfg.rssUrl, {
    headers: { 'Accept': 'application/rss+xml, application/xml, text/xml, */*' }
  }, 3, 2000);

  const xml = await res.text();
  let items = cfg.parseFn === 'atom' ? parseAtom(xml) : parseRSS(xml);
  items = items.filter(s => s.url && s.url.startsWith('http')).slice(0, count);

  return items.map(s => ({ title: s.title, url: s.url, desc: s.desc || '' }));
}

// ---------- Fetch HN stories ----------
async function fetchHNStories(count = 5) {
  const res = await fetchWithRetry(
    `${HN_API}/search?tags=front_page&hitsPerPage=${count}`,
    { headers: { 'Accept': 'application/json' } },
    3, 2000
  );
  const data = await res.json();
  return data.hits.filter(s => s.url).map(s => ({
    id: s.objectID, title: s.title, url: s.url,
    score: s.points || 0, by: s.author || 'unknown', descendants: s.num_comments || 0
  }));
}

// ---------- Fetch stories via Jina AI scrape ----------
async function fetchScrape(source, count = 5) {
  const cfg = SOURCES[source];
  if (!cfg || !cfg.scrapeUrl) return [];

  // Fetch page via Jina AI
  let text;
  try {
    const res = await fetchWithRetry(
      `${JINA_API_URL}${encodeURIComponent(cfg.scrapeUrl)}`,
      { headers: { 'Accept': 'text/plain' } },
      3, 5000
    );
    text = await res.text();
  } catch (err) {
    log(`  [ERROR] Jina scrape failed: ${err.message}`);
    return [];
  }

  // Find URLs and extract title/views from surrounding context
  const urlRegex = /https?:\/\/www\.autohome\.com\.cn\/news\/\d+\/\d+\.html/g;
  const urlMatches = [...text.matchAll(urlRegex)];

  const seen = new Set();
  const articles = [];

  for (const m of urlMatches) {
    const rawUrl = m[0].split('#')[0];
    if (seen.has(rawUrl)) continue;
    seen.add(rawUrl);

    const pos = m.index;
    const before = text.substring(Math.max(0, pos - 600), pos);

    // Extract title: find ### after [![Image
    const imgIdx = before.lastIndexOf('[Image');
    const titleStart = before.indexOf('###', imgIdx);
    let title = '';
    if (titleStart > -1) {
      const titleEnd = before.indexOf('_', titleStart);
      if (titleEnd > -1 && titleEnd - titleStart < 200) {
        title = before.substring(titleStart + 3, titleEnd).trim();
      }
    }

    // Extract views: find pattern _number_ or _X万_ before [category]
    const bracketIdx = before.lastIndexOf('[汽车之家');
    let views = 0;
    if (bracketIdx > -1) {
      const viewsArea = before.substring(bracketIdx - 100, bracketIdx);
      const viewMatch = viewsArea.match(/_(\d+(?:\.\d+)?万?)_\s*_(\d+)_/);
      if (viewMatch) {
        const viewStr = viewMatch[1];
        if (viewStr.includes('万')) {
          views = parseFloat(viewStr) * 10000;
        } else {
          views = parseInt(viewStr, 10);
        }
      }
    }

    if (title && rawUrl.includes('/news/')) {
      articles.push({ title, url: rawUrl, views });
    }
  }

  // Sort by views descending, take top N
  articles.sort((a, b) => b.views - a.views);
  return articles.slice(0, count);
}

// ---------- Fetch article text ----------
async function fetchArticleText(url) {
  try {
    const res = await fetchWithRetry(
      `${JINA_API_URL}${encodeURIComponent(url)}`,
      { headers: { 'Accept': 'text/plain' } },
      2, 1500
    );
    if (!res.ok) return null;
    let text = await res.text();
    return text
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/^\*\s/gm, '')
      .replace(/^-\s/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim().substring(0, 3000);
  } catch (err) {
    log(`   [fetch error]: ${err.message}`);
    return null;
  }
}

// ---------- Parse judge result ----------
function parseJudgeResult(result) {
  const titleMatch = result.match(/TITLE_SCORE:\s*(\d+)\s*\|\s*TITLE_WINNER:\s*(minimax|doubao)/i);
  const contentMatch = result.match(/CONTENT_SCORE:\s*(\d+)\s*\|\s*CONTENT_WINNER:\s*(minimax|doubao)/i);

  return {
    titleScore: titleMatch ? parseInt(titleMatch[1]) : null,
    titleWinner: titleMatch ? titleMatch[2].toLowerCase() : null,
    contentScore: contentMatch ? parseInt(contentMatch[1]) : null,
    contentWinner: contentMatch ? contentMatch[2].toLowerCase() : null
  };
}

// ---------- Upsert ----------
async function upsertBlogPost(story, {
  titleEn, titleZh, contentEn, contentZh,
  titleZhMinimax, titleZhDoubao, titleTranslationScore, titleWinner,
  contentZhMinimax, contentZhDoubao, contentTranslationScore, contentWinner,
  source, categoryId
}) {
  if (!contentEn || contentEn.length < 200) {
    log(`  [SKIP] content_en too short (${contentEn?.length || 0}), need 300+`);
    return;
  }
  if (!contentZh || contentZh.length < 200) {
    log(`  [SKIP] content_zh too short (${contentZh?.length || 0}), need 300+`);
    return;
  }

  const payload = {
    title: `${titleEn} → ${titleZh}`,
    content: `Source: ${story.url}`,
    title_en: titleEn,
    title_zh: titleZh,
    content_en: contentEn,
    content_zh: contentZh,
    original_url: story.url,
    category_id: categoryId || SOURCES[source]?.category_id || '9126cc45-ac4c-42de-aca8-175d51351ab2',
    source: source,
    title_zh_minimax: titleZhMinimax,
    title_zh_doubao: titleZhDoubao,
    title_translation_score: titleTranslationScore,
    title_winner: titleWinner,
    content_zh_minimax: contentZhMinimax,
    content_zh_doubao: contentZhDoubao,
    content_translation_score: contentTranslationScore,
    content_winner: contentWinner
  };

  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/blog_posts?or=(title_en.eq.${encodeURIComponent(titleEn)},original_url.eq.${encodeURIComponent(story.url)})&select=id`,
    { headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Prefer': 'representation' } }
  );
  let existing = [];
  try { existing = JSON.parse(await checkRes.text()); } catch (e) {}

  if (existing.length > 0) {
    log(`  [SKIP] Duplicate: "${titleEn}"`);
    return;
  }

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'representation' },
    body: JSON.stringify(payload)
  });
  log(`  [ADDED] ${titleEn} → ${titleZh} (${source})`);
  if (titleTranslationScore !== null) {
    log(`    Title winner: ${titleWinner} (score: ${titleTranslationScore})`);
    log(`    Content winner: ${contentWinner} (score: ${contentTranslationScore})`);
  }
}

// ---------- Check if text is primarily Chinese ----------
function isChineseText(text) {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalChars = text.replace(/\s/g, '').length;
  return totalChars > 0 && chineseChars / totalChars > 0.5;
}

// ---------- Process single story ----------
async function processStory(story, source, { summarizer, translator, minimaxTranslator, doubaoTranslator, judge }) {
  const cfg = SOURCES[source];

  // For Chinese sources (scrape), translate title to English for title_en
  let titleEn = story.title;
  if (cfg.parseFn === 'scrape' && isChineseText(story.title)) {
    log(`  Detected Chinese source, translating title to English...`);
    try {
      // Use minimaxTranslator for Chinese->English since translator may be null when TRANSLATOR_PROVIDER=both
      titleEn = await minimaxTranslator.complete(
        `Translate to English: ${story.title}`,
        'You are a professional translator. Output only the English translation.'
      );
      titleEn = titleEn || story.title;
      log(`  Title EN: ${titleEn}`);
    } catch (err) {
      log(`  [WARN] Title translation to English failed: ${err.message}, using original`);
    }
  }

  // Check duplicate
  const dupCheckRes = await fetch(
    `${SUPABASE_URL}/rest/v1/blog_posts?or=(title_en.eq.${encodeURIComponent(titleEn)},original_url.eq.${encodeURIComponent(story.url)})&select=id`,
    { headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Prefer': 'representation' } }
  );
  let isDup = false;
  try {
    const dupData = await dupCheckRes.json();
    if (dupData && dupData.length > 0) isDup = true;
  } catch (e) {}

  if (isDup) {
    log(`  [SKIP] Already exists: "${titleEn}"`);
    return;
  }

  // Fetch article text
  const articleText = await fetchArticleText(story.url);
  if (!articleText) {
    log(`  No article text, skipping`);
    return;
  }

  log(`  Article fetched (${articleText.length} chars), summarizing...`);

  // Step 1: Summarize article
  let contentEn;
  try {
    contentEn = await summarizer.complete(
      `Write a detailed English summary, at least 300 characters, plain prose:\n\n${articleText.substring(0, 3000)}`,
      'You are a tech writer. Write clear, detailed summaries.'
    );
  } catch (err) {
    log(`  [ERROR] Summarization failed: ${err.message}`);
    return;
  }

  if (!contentEn) {
    log(`  Summarization failed, skipping`);
    return;
  }

  const cleanedContentEn = contentEn
    .replace(/^>\s*/gm, '').replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^- {1,3}/gm, '').replace(/^[\s]*[-*_]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();

  if (cleanedContentEn.length < 200) {
    log(`  [SKIP] Summary too short (${cleanedContentEn.length}), need 300+`);
    return;
  }

  log(`  EN: ${cleanedContentEn.substring(0, 60)}...`);

  // Step 2: Translate with both providers
  let titleZhMinimax, titleZhDoubao, contentZhMinimax, contentZhDoubao;
  let titleZh, contentZh;
  let titleScore = 80, titleWinner = TRANSLATOR_PROVIDER, contentScore = 80, contentWinner = TRANSLATOR_PROVIDER;

  if (TRANSLATOR_PROVIDER === 'both') {
    log(`  Translating title and content with both providers in parallel...`);

    try {
      const [zhMinimaxResult, zhDoubaoResult] = await Promise.all([
        minimaxTranslator.complete(
          `Translate to Chinese: ${story.title}`,
          'You are a professional translator. Output only the Chinese translation.'
        ),
        doubaoTranslator.complete(
          `Translate to Chinese: ${story.title}`,
          'You are a professional translator. Output only the Chinese translation.'
        )
      ]);
      titleZhMinimax = zhMinimaxResult;
      titleZhDoubao = zhDoubaoResult;

      const [contentZhMinimaxResult, contentZhDoubaoResult] = await Promise.all([
        minimaxTranslator.complete(
          `Translate to Chinese. Only output Chinese, nothing else:\n${cleanedContentEn.substring(0, 1500)}`,
          'You are a professional translator.'
        ),
        doubaoTranslator.complete(
          `Translate to Chinese. Only output Chinese, nothing else:\n${cleanedContentEn.substring(0, 1500)}`,
          'You are a professional translator.'
        )
      ]);
      contentZhMinimax = contentZhMinimaxResult;
      contentZhDoubao = contentZhDoubaoResult;
    } catch (err) {
      log(`  [ERROR] Translation failed: ${err.message}`);
      return;
    }

    // Step 3: Judge which translation is better
    titleScore = 80; titleWinner = 'minimax'; contentScore = 80; contentWinner = 'minimax';
    log(`  Judging translations...`);
    try {
      const judgeResult = await judge.complete(
        `Compare these two Chinese translations and decide which is better.

ORIGINAL ENGLISH TITLE: ${story.title}
TRANSLATION A (Minimax): ${titleZhMinimax || 'FAILED'}
TRANSLATION B (Doubao): ${titleZhDoubao || 'FAILED'}

ORIGINAL ENGLISH SUMMARY: ${cleanedContentEn.substring(0, 500)}
TRANSLATION A (Minimax): ${contentZhMinimax ? contentZhMinimax.substring(0, 300) : 'FAILED'}
TRANSLATION B (Doubao): ${contentZhDoubao ? contentZhDoubao.substring(0, 300) : 'FAILED'}

Respond with:
TITLE_SCORE: <0-100> | TITLE_WINNER: <minimax|doubao>
CONTENT_SCORE: <0-100> | CONTENT_WINNER: <minimax|doubao>`,
        'You are a translation quality judge. Score translations 0-100 and pick winners.'
      );

      const parsed = parseJudgeResult(judgeResult);
      titleScore = parsed.titleScore || 80;
      titleWinner = parsed.titleWinner || 'minimax';
      contentScore = parsed.contentScore || 80;
      contentWinner = parsed.contentWinner || 'minimax';
      log(`  Title: ${titleWinner} won (score: ${titleScore})`);
      log(`  Content: ${contentWinner} won (score: ${contentScore})`);

      titleZh = titleWinner === 'doubao' ? titleZhDoubao : titleZhMinimax;
      contentZh = contentWinner === 'doubao' ? contentZhDoubao : contentZhMinimax;
    } catch (err) {
      log(`  [ERROR] Judge failed: ${err.message}, using Minimax by default`);
      titleZh = titleZhMinimax || titleZhDoubao || story.title;
      contentZh = contentZhMinimax || contentZhDoubao || '';
      titleScore = 80;
      titleWinner = 'minimax';
      contentScore = 80;
      contentWinner = 'minimax';
    }
  } else {
    // Single provider mode
    try {
      titleZh = await translator.complete(
        `Translate to Chinese: ${story.title}`,
        'You are a professional translator. Output only the Chinese translation.'
      );
      contentZh = await translator.complete(
        `Translate to Chinese. Only output Chinese, nothing else:\n${cleanedContentEn.substring(0, 1500)}`,
        'You are a professional translator.'
      );
    } catch (err) {
      log(`  [ERROR] Translation failed: ${err.message}`);
      return;
    }
  }

  if (!contentZh || contentZh.length < 50) {
    log(`  [SKIP] Translation too short or failed`);
    return;
  }

  await upsertBlogPost(story, {
    titleEn: titleEn,
    titleZh,
    contentEn: cleanedContentEn,
    contentZh,
    titleZhMinimax, titleZhDoubao,
    titleTranslationScore: TRANSLATOR_PROVIDER === 'both' ? titleScore : null,
    titleWinner: TRANSLATOR_PROVIDER === 'both' ? titleWinner : TRANSLATOR_PROVIDER,
    contentZhMinimax, contentZhDoubao,
    contentTranslationScore: TRANSLATOR_PROVIDER === 'both' ? contentScore : null,
    contentWinner: TRANSLATOR_PROVIDER === 'both' ? contentWinner : TRANSLATOR_PROVIDER,
    source,
    categoryId: cfg?.category_id
  });

  await new Promise(r => setTimeout(r, 500));
}

// ---------- Main ----------
async function main() {
  const args = process.argv.slice(2);
  const countArg = args.find(a => !a.startsWith('--'));
  const count = countArg ? parseInt(countArg, 10) : 5;
  const loopHours = parseFloat(args.find(a => a.startsWith('--loop='))?.split('=')[1] || '0');
  const sourceArg = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'all';
  const intervalMs = loopHours > 0 ? loopHours * 60 * 60 * 1000 : 0;

  log(`[PROVIDERS] summarizer=${SUMMARIZER_PROVIDER}, translator=${TRANSLATOR_PROVIDER}, judge=${JUDGE_PROVIDER}`);

  let summarizer, translator, minimaxTranslator, doubaoTranslator, judge;
  try {
    summarizer = await createProvider(SUMMARIZER_PROVIDER);
    translator = TRANSLATOR_PROVIDER === 'both' ? null : await createProvider(TRANSLATOR_PROVIDER);
    minimaxTranslator = await createProvider('minimax');
    doubaoTranslator = await createProvider('doubao');
    judge = await createProvider(JUDGE_PROVIDER);
  } catch (err) {
    console.error(`[PROVIDER ERROR] Failed to initialize providers: ${err.message}`);
    process.exit(1);
  }

  const sourcesToFetch = sourceArg === 'all' ? Object.keys(SOURCES) : sourceArg.split(',');

  async function run() {
    log(`\n[${new Date().toISOString()}] Starting sync for: ${sourcesToFetch.join(', ')}`);

    for (const source of sourcesToFetch) {
      const cfg = SOURCES[source];
      if (!cfg) {
        log(`Unknown source: ${source}`);
        continue;
      }

      log(`\n--- ${cfg.name} (${source}) ---`);

      let stories = [];
      try {
        if (source === 'hn') {
          stories = await fetchHNStories(count);
        } else if (cfg.parseFn === 'scrape') {
          stories = await fetchScrape(source, count);
        } else {
          stories = await fetchRSS(source, count);
        }
      } catch (err) {
        log(`  [ERROR] Failed to fetch from ${source}: ${err.message}`);
        continue;
      }

      log(`Got ${stories.length} stories`);

      for (const story of stories) {
        log(`Processing: ${story.title}`);
        await processStory(story, source, { summarizer, translator, minimaxTranslator, doubaoTranslator, judge });
      }
    }

    log(`\n[${new Date().toISOString()}] Done!`);
  }

  await run();

  if (intervalMs > 0) {
    log(`\nScheduled to run every ${loopHours}h. Press Ctrl+C to stop.`);
    setInterval(run, intervalMs);
  }
}

main();
