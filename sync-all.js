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
import { readFileSync } from 'fs';

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

// ---------- Sources config ----------
const SOURCES = {
  hn: {
    name: 'Hacker News',
    tag: 'hn',
    category_id: '9126cc45-ac4c-42de-aca8-175d51351ab2',
    rssUrl: null,
    parseFn: null
  },
  tc: {
    name: 'TechCrunch',
    tag: 'tc',
    category_id: '9126cc45-ac4c-42de-aca8-175d51351ab2',
    rssUrl: 'https://techcrunch.com/feed/',
    parseFn: 'rss'
  },
  verge: {
    name: 'The Verge',
    tag: 'verge',
    category_id: '9126cc45-ac4c-42de-aca8-175d51351ab2',
    rssUrl: 'https://www.theverge.com/rss/index.xml',
    parseFn: 'atom'
  },
  ars: {
    name: 'Ars Technica',
    tag: 'ars',
    category_id: '9126cc45-ac4c-42de-aca8-175d51351ab2',
    rssUrl: 'https://feeds.arstechnica.com/arstechnica/index',
    parseFn: 'rss'
  }
};

// ---------- Fetch with retry ----------
async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok && res.status >= 500 && i < retries - 1) {
        console.log(`  [retry] ${res.status} from ${url}, attempt ${i + 1}/${retries}`);
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      if (i < retries - 1) {
        console.log(`  [retry] ${err.message}, attempt ${i + 1}/${retries}`);
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
    console.log(`   [fetch error]: ${err.message}`);
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
    console.log(`  [SKIP] content_en too short (${contentEn?.length || 0}), need 300+`);
    return;
  }
  if (!contentZh || contentZh.length < 200) {
    console.log(`  [SKIP] content_zh too short (${contentZh?.length || 0}), need 300+`);
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
    console.log(`  [SKIP] Duplicate: "${titleEn}"`);
    return;
  }

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'representation' },
    body: JSON.stringify(payload)
  });
  console.log(`  [ADDED] ${titleEn} → ${titleZh} (${source})`);
  if (titleTranslationScore !== null) {
    console.log(`    Title winner: ${titleWinner} (score: ${titleTranslationScore})`);
    console.log(`    Content winner: ${contentWinner} (score: ${contentTranslationScore})`);
  }
}

// ---------- Process single story ----------
async function processStory(story, source, { summarizer, translator, minimaxTranslator, doubaoTranslator, judge }) {
  const cfg = SOURCES[source];

  // Check duplicate
  const dupCheckRes = await fetch(
    `${SUPABASE_URL}/rest/v1/blog_posts?or=(title_en.eq.${encodeURIComponent(story.title)},original_url.eq.${encodeURIComponent(story.url)})&select=id`,
    { headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Prefer': 'representation' } }
  );
  let isDup = false;
  try {
    const dupData = await dupCheckRes.json();
    if (dupData && dupData.length > 0) isDup = true;
  } catch (e) {}

  if (isDup) {
    console.log(`  [SKIP] Already exists: "${story.title}"`);
    return;
  }

  // Fetch article text
  const articleText = await fetchArticleText(story.url);
  if (!articleText) {
    console.log(`  No article text, skipping`);
    return;
  }

  console.log(`  Article fetched (${articleText.length} chars), summarizing...`);

  // Step 1: Summarize article
  let contentEn;
  try {
    contentEn = await summarizer.complete(
      `Write a detailed English summary, at least 300 characters, plain prose:\n\n${articleText.substring(0, 3000)}`,
      'You are a tech writer. Write clear, detailed summaries.'
    );
  } catch (err) {
    console.log(`  [ERROR] Summarization failed: ${err.message}`);
    return;
  }

  if (!contentEn) {
    console.log(`  Summarization failed, skipping`);
    return;
  }

  const cleanedContentEn = contentEn
    .replace(/^>\s*/gm, '').replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^- {1,3}/gm, '').replace(/^[\s]*[-*_]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();

  if (cleanedContentEn.length < 200) {
    console.log(`  [SKIP] Summary too short (${cleanedContentEn.length}), need 300+`);
    return;
  }

  console.log(`  EN: ${cleanedContentEn.substring(0, 60)}...`);

  // Step 2: Translate with both providers
  let titleZhMinimax, titleZhDoubao, contentZhMinimax, contentZhDoubao;
  let titleZh, contentZh;

  if (TRANSLATOR_PROVIDER === 'both') {
    console.log(`  Translating title and content with both providers in parallel...`);

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
      console.log(`  [ERROR] Translation failed: ${err.message}`);
      return;
    }

    // Step 3: Judge which translation is better
    let titleScore = 80, titleWinner = 'minimax', contentScore = 80, contentWinner = 'minimax';
    console.log(`  Judging translations...`);
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
      console.log(`  Title: ${titleWinner} won (score: ${titleScore})`);
      console.log(`  Content: ${contentWinner} won (score: ${contentScore})`);

      titleZh = titleWinner === 'doubao' ? titleZhDoubao : titleZhMinimax;
      contentZh = contentWinner === 'doubao' ? contentZhDoubao : contentZhMinimax;
    } catch (err) {
      console.log(`  [ERROR] Judge failed: ${err.message}, using Minimax by default`);
      titleZh = titleZhMinimax || titleZhDoubao || story.title;
      contentZh = contentZhMinimax || contentZhDoubao || '';
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
      console.log(`  [ERROR] Translation failed: ${err.message}`);
      return;
    }
  }

  if (!contentZh || contentZh.length < 50) {
    console.log(`  [SKIP] Translation too short or failed`);
    return;
  }

  await upsertBlogPost(story, {
    titleEn: story.title,
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

  console.log(`[PROVIDERS] summarizer=${SUMMARIZER_PROVIDER}, translator=${TRANSLATOR_PROVIDER}, judge=${JUDGE_PROVIDER}`);

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
    console.log(`\n[${new Date().toISOString()}] Starting sync for: ${sourcesToFetch.join(', ')}`);

    for (const source of sourcesToFetch) {
      const cfg = SOURCES[source];
      if (!cfg) {
        console.log(`Unknown source: ${source}`);
        continue;
      }

      console.log(`\n--- ${cfg.name} (${source}) ---`);

      let stories = [];
      if (source === 'hn') {
        stories = await fetchHNStories(count);
      } else {
        stories = await fetchRSS(source, count);
      }

      console.log(`Got ${stories.length} stories`);

      for (const story of stories) {
        console.log(`Processing: ${story.title}`);
        await processStory(story, source, { summarizer, translator, minimaxTranslator, doubaoTranslator, judge });
      }
    }

    console.log(`\n[${new Date().toISOString()}] Done!`);
  }

  await run();

  if (intervalMs > 0) {
    console.log(`\nScheduled to run every ${loopHours}h. Press Ctrl+C to stop.`);
    setInterval(run, intervalMs);
  }
}

main();
