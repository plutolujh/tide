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
import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
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
    await generateStaticIndex();
  }

  await run();

  if (intervalMs > 0) {
    log(`\nScheduled to run every ${loopHours}h. Press Ctrl+C to stop.`);
    setInterval(run, intervalMs);
  }
}

// ---------- Generate static index.html from latest DB posts ----------
function escapeHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

async function generateStaticIndex() {
  log('[STATIC] Generating static index.html from latest posts...');

  // Fetch latest 100 posts from Supabase
  let url = `${SUPABASE_URL}/rest/v1/blog_posts?select=*,categories(id,title,sort_order)&order=created_at.desc&limit=30`;
  const res = await fetchWithRetry(url, {
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}` }
  });
  const posts = await res.json();

  // Build the posts HTML
  const postsHtml = posts.map((post, i) => `
            <li class="post-item" style="animation-delay:${i * 0.07}s">
              <div class="post-link" onclick="goTo('/post/${post.id}')">
                <div class="post-item-title">${escapeHtml(post.title_zh || post.title_en || post.title)}</div>
                <div class="post-item-meta">
                  ${post.categories ? `<span>${escapeHtml(post.categories.title)}</span>` : ''}
                  ${post.source ? `<span>${escapeHtml(post.source.toUpperCase())}</span>` : ''}
                  <span class="dot"></span>
                  <span>${formatDate(post.created_at)}</span>
                </div>
                ${post.content_zh || post.content_en ? `<div class="post-item-excerpt">${escapeHtml((post.content_zh || post.content_en).substring(0, 350))}</div>` : ''}
              </div>
            </li>`).join('');

  const now = new Date().toISOString();

  const staticHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>潮汐 · Tides</title>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap" media="print" onload="this.media='all'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap"></noscript>
  <style>
    :root {
      --bg-primary: #0f0e0d;
      --bg-secondary: #1a1816;
      --bg-tertiary: #242220;
      --text-primary: #e8e2d8;
      --text-secondary: #9a9288;
      --text-tertiary: #5a5650;
      --accent: #d4a055;
      --accent-dim: rgba(212, 160, 85, 0.12);
      --border: #2a2724;
      --border-light: #383530;
      --font-display: 'Cormorant Garamond', Georgia, serif;
      --font-mono: 'Courier Prime', 'Courier New', monospace;
      --transition-fast: 0.15s ease;
      --transition-slow: 0.4s ease;
    }
    [data-theme="light"] {
      --bg-primary: #f5f0e8;
      --bg-secondary: #ebe5db;
      --bg-tertiary: #e0d9cc;
      --text-primary: #1e1a16;
      --text-secondary: #5c5650;
      --text-tertiary: #9a9590;
      --accent: #9b6238;
      --accent-dim: rgba(155, 98, 56, 0.1);
      --border: #d4cdc2;
      --border-light: #e0d9cc;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      font-family: var(--font-display);
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.7;
      min-height: 100vh;
      transition: background var(--transition-slow), color var(--transition-slow);
    }
    ::selection { background: var(--accent); color: var(--bg-primary); }
    a { color: inherit; text-decoration: none; }
    .container { max-width: 680px; margin: 0 auto; padding: 100px 32px 140px; }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
      opacity: 0.025;
      z-index: 9999;
    }
    .site-header { margin-bottom: 80px; position: relative; }
    .site-meta { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-tertiary); margin-bottom: 24px; display: flex; align-items: center; gap: 16px; }
    .site-meta::after { content: ''; display: block; width: 40px; height: 1px; background: var(--border); }
    .site-title { font-size: clamp(36px, 6vw, 56px); font-weight: 300; letter-spacing: -0.02em; line-height: 1.05; color: var(--text-primary); margin-bottom: 8px; }
    .site-title span { color: var(--accent); font-style: italic; }
    .site-tagline { font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); letter-spacing: 0.08em; }
    .controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 56px; padding-bottom: 32px; border-bottom: 1px solid var(--border); flex-wrap: wrap; gap: 12px; }
    .toggles-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
    .lang-toggle, .source-toggle { display: flex; gap: 0; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
    .lang-toggle button, .source-toggle button { font-family: var(--font-mono); font-size: 10px; padding: 6px 12px; border: none; background: transparent; color: var(--text-tertiary); cursor: pointer; transition: all var(--transition-fast); letter-spacing: 0.05em; }
    .lang-toggle button:hover, .source-toggle button:hover { color: var(--text-primary); background: var(--bg-secondary); }
    .lang-toggle button.active, .source-toggle button.active { background: var(--text-primary); color: var(--bg-primary); }
    .lang-toggle button + button, .source-toggle button + button { border-left: 1px solid var(--border); }
    .theme-toggle { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.05em; color: var(--text-tertiary); cursor: pointer; padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; background: transparent; transition: all var(--transition-fast); }
    .theme-toggle:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
    .posts-list { list-style: none; }
    .post-item { border-bottom: 1px solid var(--border); }
    .post-link { display: block; padding: 40px 0; cursor: pointer; transition: padding-left var(--transition-fast); }
    .post-link:hover { padding-left: 16px; }
    .post-link:hover .post-item-title { color: var(--accent); }
    .post-item-title { font-size: clamp(20px, 3.5vw, 26px); font-weight: 400; line-height: 1.25; letter-spacing: -0.01em; margin-bottom: 10px; transition: color var(--transition-fast); }
    .post-item-meta { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 10px; }
    .post-item-meta span { display: flex; align-items: center; gap: 5px; }
    .post-item-meta .dot { width: 3px; height: 3px; background: var(--border-light); border-radius: 50%; }
    .post-item-excerpt { font-size: 14px; color: var(--text-secondary); line-height: 1.7; font-style: italic; display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-line; }
    .post-detail { animation: fadeIn 0.5s ease; }
    .back-link { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); margin-bottom: 56px; cursor: pointer; transition: color var(--transition-fast); letter-spacing: 0.05em; }
    .back-link:hover { color: var(--accent); }
    .back-link svg { transition: transform var(--transition-fast); }
    .back-link:hover svg { transform: translateX(-4px); }
    .post-header { margin-bottom: 48px; }
    .post-category { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; color: var(--accent); margin-bottom: 20px; }
    .post-title { font-size: clamp(28px, 5vw, 44px); font-weight: 400; line-height: 1.15; letter-spacing: -0.02em; margin-bottom: 24px; }
    .post-meta { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); display: flex; gap: 16px; flex-wrap: wrap; padding-bottom: 32px; border-bottom: 1px solid var(--border); margin-bottom: 40px; }
    .post-meta span { display: flex; align-items: center; gap: 6px; }
    .post-body { font-size: 18px; line-height: 1.85; color: var(--text-secondary); }
    .post-body p { margin-bottom: 28px; }
    .post-body p:last-child { margin-bottom: 0; }
    .content-divider { border: none; border-top: 1px solid var(--border); margin: 48px 0; }
    .post-url { display: inline-flex; align-items: center; gap: 8px; margin-top: 48px; padding: 14px 28px; background: var(--accent); color: var(--bg-primary); font-family: var(--font-mono); font-size: 11px; border-radius: 3px; transition: opacity var(--transition-fast), transform var(--transition-fast); }
    .post-url:hover { opacity: 0.85; transform: translateY(-1px); }
    .loading { text-align: center; padding: 100px 0; font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); letter-spacing: 0.1em; }
    .loading::after { content: ''; display: inline-block; width: 4px; height: 4px; background: var(--accent); border-radius: 50%; margin-left: 10px; animation: blink 1.2s ease infinite; }
    .error-msg { text-align: center; padding: 60px 40px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); }
    .more-btn { display: block; width: 100%; margin: 64px 0; padding: 18px 0; background: transparent; border: 1px solid var(--border); border-radius: 4px; color: var(--text-tertiary); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; cursor: pointer; position: relative; overflow: hidden; transition: all var(--transition-slow); }
    .more-btn::before { content: ''; position: absolute; inset: 0; background: var(--accent-dim); transform: scaleX(0); transform-origin: left; transition: transform var(--transition-slow); }
    .more-btn:hover { border-color: var(--accent); color: var(--accent); }
    .more-btn:hover::before { transform: scaleX(1); }
    .more-btn.loading { color: var(--text-tertiary); border-color: var(--border); cursor: default; pointer-events: none; }
    .more-btn.loading::before { display: none; }
    .more-btn.loading::after { content: ''; display: inline-block; width: 4px; height: 4px; background: var(--accent); border-radius: 50%; margin-left: 10px; animation: blink 1.2s ease infinite; }
    footer { margin-top: 100px; padding-top: 32px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); letter-spacing: 0.05em; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
    @media (max-width: 600px) { .container { padding: 60px 20px 80px; } .post-link { padding: 28px 0; } .post-link:hover { padding-left: 0; } .controls { flex-direction: column; gap: 12px; align-items: flex-start; } .post-url { display: block; text-align: center; } }
  </style>
</head>
<body>
  <div class="container">
    <div id="app"></div>
    <footer>
      <span>潮汐 Tides · Powered by Supabase</span>
      <span id="theme-label">Dark Mode</span>
    </footer>
  </div>
  <script>
    // Embedded posts data — generated at ${now}
    window.__POSTS_DATA__ = ${JSON.stringify(posts.map(p => ({
      id: p.id,
      title: p.title,
      title_en: p.title_en,
      title_zh: p.title_zh,
      content_en: p.content_en,
      content_zh: p.content_zh,
      source: p.source,
      created_at: p.created_at,
      original_url: p.original_url,
      categories: p.categories
    })))};
  </script>
  <script>
    const SUPABASE_URL = 'https://fzxuotfihpbzozjoplim.supabase.co';
    const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6eHVvdGZpaHBiem96am9wbGltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3OTM1MzMsImV4cCI6MjA5MTM2OTUzM30.pfhwZ7kv4CUy5PT_s62WzfIC3cHeXR2Z4YIXUjjqY1c';

    const app = document.getElementById('app');

    let titleLang = localStorage.getItem('titleLang') || 'zh';
    let contentLang = localStorage.getItem('contentLang') || 'zh';
    let currentTheme = localStorage.getItem('theme') || 'dark';
    let groupFilter = localStorage.getItem('groupFilter') || 'all';
    let categories = [];
    let displayedPosts = [];
    let currentOffset = 30;
    let hasMore = false;
    let isLoadingMore = false;

    function applyTheme() {
      document.documentElement.setAttribute('data-theme', currentTheme);
      document.getElementById('theme-label').textContent = currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode';
    }
    applyTheme();

    function toggleTheme() {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', currentTheme);
      applyTheme();
    }

    function setTitleLang(lang) {
      titleLang = lang;
      localStorage.setItem('titleLang', lang);
      currentOffset = 30;
      handleRoute();
    }

    function setContentLang(lang) {
      contentLang = lang;
      localStorage.setItem('contentLang', lang);
      handleRoute();
    }

    function setGroupFilter(grp) {
      groupFilter = grp;
      localStorage.setItem('groupFilter', grp);
      currentOffset = 30;
      handleRoute();
    }

    async function fetchCategories() {
      const response = await fetch(
        SUPABASE_URL + '/rest/v1/categories?select=id,title,sort_order&order=sort_order.asc',
        { headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY } }
      );
      if (!response.ok) throw new Error('Failed to fetch categories');
      return response.json();
    }

    function getPostIdFromHash() {
      const match = window.location.hash.match(/^#\/post\/(.+)/);
      return match ? match[1] : null;
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatDate(dateStr) {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }

    function getDisplayTitle(post) {
      if (titleLang === 'en') return escapeHtml(post.title_en || post.title);
      if (titleLang === 'zh') return escapeHtml(post.title_zh || post.title_en || post.title);
      return escapeHtml(post.title);
    }

    function getDisplayContent(post) {
      const en = post.content_en || '';
      const zh = post.content_zh || '';
      if (contentLang === 'en') return en;
      if (contentLang === 'zh') return zh;
      if (en && zh) return zh + '\\n---\\n' + en;
      return zh || en;
    }

    function getDisplayExcerpt(post) {
      const en = post.content_en || '';
      const zh = post.content_zh || '';
      if (titleLang === 'en') return en.substring(0, 150);
      if (titleLang === 'zh') return zh.substring(0, 100);
      if (titleLang === 'all') {
        if (en && zh) return zh.substring(0, 80) + '\\n\\n📖 EN: ' + en.substring(0, 200);
        if (en) return en.substring(0, 280);
        if (zh) return zh.substring(0, 280);
      }
      return (zh || en).substring(0, 150);
    }

    function langToggleHtml(selected, onChange) {
      const langs = [{ code: 'zh', label: '中文' }, { code: 'en', label: 'EN' }, { code: 'all', label: 'All' }];
      return '<div class="lang-toggle">' +
        langs.map(l =>
          '<button class="' + (l.code === selected ? 'active' : '') + '" onclick="' + onChange + '(\\'' + l.code + '\\')">' + l.label + '</button>'
        ).join('') +
        '</div>';
    }

    function groupToggleHtml(selected, groups) {
      const filtered = groups.filter(g => g.title !== '科技');
      const items = [{ code: 'all', label: '全部' }, ...filtered.map(g => ({ code: g.title, label: g.title }))];
      return '<div class="lang-toggle">' +
        items.map(g =>
          '<button class="' + (g.code === selected ? 'active' : '') + '" onclick="setGroupFilter(\\'' + g.code + '\\')">' + g.label + '</button>'
        ).join('') +
        '</div>';
    }

    async function fetchPost(id) {
      // Try embedded data first
      const fromEmbed = window.__POSTS_DATA__ ? window.__POSTS_DATA__.find(p => p.id === id) : null;
      if (fromEmbed) return fromEmbed;
      // Fallback to network
      const response = await fetch(
        SUPABASE_URL + '/rest/v1/blog_posts?id=eq.' + id + '&select=*,categories(id,title)',
        { headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY } }
      );
      if (!response.ok) throw new Error('Failed to fetch');
      const data = await response.json();
      return data[0] || null;
    }

    function getPostUrl(post) {
      if (post.original_url) return post.original_url;
      if (post.content) {
        const match = post.content.match(/https?:\/\/[^\s]+/);
        if (match) return match[0];
      }
      return null;
    }

    function goTo(path) { window.location.hash = path; }

    async function renderPost(id) {
      app.innerHTML = '<div class="loading">Loading...</div>';
      try {
        const post = await fetchPost(id);
        if (!post) {
          app.innerHTML = '<div class="post-detail"><div class="back-link" onclick="goTo(\\'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>Back</div><div class="error-msg">Post not found</div></div>';
          return;
        }
        const displayTitle = getDisplayTitle(post);
        const displayContent = getDisplayContent(post);
        const postUrl = getPostUrl(post);
        app.innerHTML = '<div class="post-detail"><div class="back-link" onclick="goTo(\\'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>Back</div>' + langToggleHtml(contentLang, 'setContentLang') + '<article><header class="post-header">' + (post.categories ? '<div class="post-category">' + escapeHtml(post.categories.title) + '</div>' : '') + '<h1 class="post-title">' + displayTitle + '</h1><div class="post-meta"><span>' + formatDate(post.created_at) + '</span></div></header><div class="post-body">' + (displayContent ? displayContent.split('\\n').map(p => '<p>' + escapeHtml(p) + '</p>').join('') : '<p>No content available.</p>') + '</div>' + (postUrl ? '<a href="' + postUrl + '" target="_blank" class="post-url"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>Read Original</a>' : '') + '</article></div>';
      } catch (err) {
        app.innerHTML = '<div class="post-detail"><div class="back-link" onclick="goTo(\\'\\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>Back</div><div class="error-msg">Unable to load post</div></div>';
        console.error(err);
      }
    }

    function renderPosts(isLoadingMoreFlag) {
      if (displayedPosts.length === 0) {
        app.innerHTML = '<div class="site-header"><div class="site-meta">潮汐 Tides</div><h1 class="site-title">潮汐 <span>·</span> Tides</h1><p class="site-tagline">Stories &amp; Ideas · 故事与思想</p></div><div class="controls"><div class="toggles-row">' + groupToggleHtml(groupFilter, categories) + langToggleHtml(titleLang, 'setTitleLang') + '</div><button class="theme-toggle" onclick="toggleTheme()">Light Mode</button></div><div style="text-align:center;padding:80px 0;color:var(--text-tertiary);font-family:var(--font-mono);font-size:11px;">No posts yet</div>';
        return;
      }
      app.innerHTML = '<div class="site-header"><div class="site-meta">潮汐 Tides</div><h1 class="site-title">潮汐 <span>·</span> Tides</h1><p class="site-tagline">Stories &amp; Ideas · 故事与思想</p></div><div class="controls"><div class="toggles-row">' + groupToggleHtml(groupFilter, categories) + langToggleHtml(titleLang, 'setTitleLang') + '</div><button class="theme-toggle" onclick="toggleTheme()">Light Mode</button></div><ul class="posts-list">' + displayedPosts.map((post, i) => '<li class="post-item" style="animation-delay:' + (i * 0.07) + 's"><div class="post-link" onclick="goTo(\\'/post/' + post.id + '\\')"><div class="post-item-title">' + getDisplayTitle(post) + '</div><div class="post-item-meta">' + (post.categories ? '<span>' + escapeHtml(post.categories.title) + '</span>' : '') + (post.source ? '<span>' + escapeHtml(post.source.toUpperCase()) + '</span>' : '') + '<span class="dot"></span><span>' + formatDate(post.created_at) + '</span></div>' + (post.content_zh || post.content_en ? '<div class="post-item-excerpt">' + escapeHtml(getDisplayExcerpt(post).substring(0, 350)) + '</div>' : '') + '</div></li>').join('') + '</ul>' + (hasMore ? '<button class="more-btn' + (isLoadingMoreFlag ? ' loading' : '') + '" onclick="loadMore()" ' + (isLoadingMoreFlag ? 'disabled' : '') + '>' + (isLoadingMoreFlag ? 'Loading' : 'More') + '</button>' : '') + '</div>';
    }

    async function loadMore() {
      if (isLoadingMore || !hasMore) return;
      isLoadingMore = true;
      renderPosts(true);
      try {
        let url = SUPABASE_URL + '/rest/v1/blog_posts?select=*,categories(id,title,sort_order)&order=created_at.desc&limit=30&offset=' + currentOffset;
        if (groupFilter !== 'all') {
          url += '&categories.title=eq.' + encodeURIComponent(groupFilter);
        }
        const response = await fetch(url, { headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY } });
        const newPosts = await response.json();
        displayedPosts = [...displayedPosts, ...newPosts];
        hasMore = newPosts.length === 30;
        currentOffset += 30;
      } catch (err) { console.error(err); }
      isLoadingMore = false;
      renderPosts(false);
    }

    window.goTo = goTo;
    window.setTitleLang = setTitleLang;
    window.setContentLang = setContentLang;
    window.setGroupFilter = setGroupFilter;
    window.toggleTheme = toggleTheme;
    window.loadMore = loadMore;

    async function handleRoute() {
      const postId = getPostIdFromHash();
      if (postId) {
        await renderPost(postId);
      } else {
        try {
          if (categories.length === 0) {
            categories = await fetchCategories();
          }
          // Use embedded data only for "all" filter, otherwise fetch from API
          if (groupFilter !== 'all') {
            // Fetch filtered posts from API
            const filterUrl = SUPABASE_URL + '/rest/v1/blog_posts?select=*,categories(id,title,sort_order)&categories.title=eq.' + encodeURIComponent(groupFilter) + '&order=created_at.desc&limit=30';
            const res = await fetch(filterUrl, { headers: { 'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY } });
            const data = await res.json();
            displayedPosts = data;
            hasMore = data.length === 30;
            currentOffset = 30;
          } else if (window.__POSTS_DATA__ && window.__POSTS_DATA__.length > 0) {
            // Use embedded data for "all"
            displayedPosts = window.__POSTS_DATA__.slice(0, 30);
            hasMore = window.__POSTS_DATA__.length > 30;
            currentOffset = 30;
          } else {
            displayedPosts = [];
            hasMore = false;
          }
          currentOffset = 30;
          renderPosts();
        } catch (err) {
          app.innerHTML = '<div class="site-header"><div class="site-meta">潮汐 Tides</div><h1 class="site-title">潮汐 <span>·</span> Tides</h1><p class="site-tagline">Stories &amp; Ideas · 故事与思想</p></div><div class="controls">' + langToggleHtml(titleLang, 'setTitleLang') + '<button class="theme-toggle" onclick="toggleTheme()">Light Mode</button></div><div class="error-msg">Unable to load posts. Please refresh.</div>';
        }
      }
    }

    window.addEventListener('hashchange', handleRoute);
    handleRoute();
  </script>
</body>
</html>`;

  writeFileSync('index.html', staticHtml);
  log('[STATIC] Written index.html with ' + posts.length + ' posts');
}

main();
