/**
 * Hacker News Top 5 → Supabase blog_posts
 * Bilingual: English + Chinese titles and AI summaries
 *
 * Usage: node sync-hn.js
 *
 * Providers:
 * - minimax for both summarizing and translation
 *   (doubao / deepseek removed on 2026-11-25 -- minimax only now)
 */

import { createProvider } from './providers/index.js';

// Load env vars from .env file manually
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

const JINA_API_URL = 'https://r.jina.ai/';

const ANON_KEY = SUPABASE_KEY;
const HN_API = 'https://hn.algolia.com/api/v1';

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

async function fetchTopStories(count = 5) {
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

async function upsertBlogPost(story, {
  titleEn,
  titleZh,
  contentEn,
  contentZh,
  titleZhMinimax,
  titleZhDoubao = null,
  titleTranslationScore = null,
  titleWinner = null,
  contentZhMinimax,
  contentZhDoubao = null,
  contentTranslationScore = null,
  contentWinner = null
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
    content: `HN: ${story.url}\nScore: ${story.score} | By: ${story.by} | Comments: ${story.descendants || 0}`,
    title_en: titleEn,
    title_zh: titleZh,
    content_en: contentEn,
    content_zh: contentZh,
    original_url: story.url,
    category_id: '9126cc45-ac4c-42de-aca8-175d51351ab2',
    // Translation provider comparison fields
    title_zh_minimax: titleZhMinimax,
    title_zh_doubao: titleZhDoubao,
    title_translation_score: titleTranslationScore,
    title_winner: titleWinner,
    content_zh_minimax: contentZhMinimax,
    content_zh_doubao: contentZhDoubao,
    content_translation_score: contentTranslationScore,
    content_winner: contentWinner
  };

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'representation' },
    body: JSON.stringify(payload)
  });
  console.log(`  [ADDED] ${titleEn} → ${titleZh} (en:${contentEn.length} zh:${contentZh.length})`);
  if (titleTranslationScore !== null) {
    console.log(`    Title winner: ${titleWinner} (score: ${titleTranslationScore})`);
    console.log(`    Content winner: ${contentWinner} (score: ${contentTranslationScore})`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const countArg = args.find(a => !a.startsWith('--'));
  const count = countArg ? parseInt(countArg, 10) : 5;
  const loopHours = parseFloat(args.find(a => a.startsWith('--loop='))?.split('=')[1] || '0');
  const intervalMs = loopHours > 0 ? loopHours * 60 * 60 * 1000 : 0;

  // Initialize providers
  console.log(`[PROVIDERS] summarizer=${SUMMARIZER_PROVIDER}, translator=${TRANSLATOR_PROVIDER}`);

  let summarizer, translator, minimaxTranslator;
  try {
    summarizer = await createProvider(SUMMARIZER_PROVIDER);
    translator = await createProvider(TRANSLATOR_PROVIDER);
    minimaxTranslator = await createProvider('minimax');
  } catch (err) {
    console.error(`[PROVIDER ERROR] Failed to initialize providers: ${err.message}`);
    process.exit(1);
  }

  async function run() {
    console.log(`\n[${new Date().toISOString()}] Fetching HN Top ${count}...`);
    const stories = await fetchTopStories(count);
    console.log(`Got ${stories.length} stories\n`);

    for (const story of stories) {
      console.log(`Processing: ${story.title}`);

      // Check duplicate BEFORE fetching/summarizing (skip unnecessary API calls)
      const dupCheckRes = await fetch(
        `${SUPABASE_URL}/rest/v1/blog_posts?or=(title_en.eq.${encodeURIComponent(story.title)},original_url.eq.${encodeURIComponent(story.url)})&select=id`,
        { headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Prefer': 'representation' } }
      );
      let isDup = false;
      try {
        const dupData = await dupCheckRes.json();
        if (dupData && dupData.length > 0) {
          isDup = true;
          console.log(`  [SKIP] Already exists: "${story.title}"`);
        }
      } catch (e) {
        console.log(`  [ERROR] Failed to parse duplicate check response: ${e.message}`);
      }

      if (isDup) continue;

      const articleText = await fetchArticleText(story.url);
      if (!articleText) {
        console.log(`  No article text, skipping`);
        await new Promise(r => setTimeout(r, 200));
        continue;
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
        continue;
      }

      if (!contentEn) {
        console.log(`  Summarization failed, skipping`);
        continue;
      }

      const cleanedContentEn = contentEn
        .replace(/^>\s*/gm, '').replace(/^#{1,6}\s*/gm, '')
        .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^- {1,3}/gm, '').replace(/^[\s]*[-*_]{3,}\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n').trim();

      if (cleanedContentEn.length < 200) {
        console.log(`  [SKIP] Summary too short (${cleanedContentEn.length}), need 300+`);
        continue;
      }

      console.log(`  EN: ${cleanedContentEn.substring(0, 60)}...`);

      // Step 2: Translate summary to Chinese
if (TRANSLATOR_PROVIDER !== 'both') {
        // Single translator mode (minimax only)
        console.log(`  Translating with ${TRANSLATOR_PROVIDER}...`);

        let titleZh, contentZh;
        try {
          titleZh = await translator.complete(
            `Translate to Chinese: ${story.title}`,
            'You are a professional translator. Output only the Chinese translation.'
          );
        } catch (err) {
          console.log(`  [ERROR] Title translation failed: ${err.message}`);
          continue;
        }

        try {
          contentZh = await translator.complete(
            `Translate to Chinese. Only output Chinese, nothing else:\n${cleanedContentEn.substring(0, 1500)}`,
            'You are a professional translator.'
          );
        } catch (err) {
          console.log(`  [ERROR] Content translation failed: ${err.message}`);
          continue;
        }

        console.log(`  Title: ${story.title} → ${titleZh}`);
        console.log(`  ZH: ${contentZh?.substring(0, 60) || 'FAILED'}...`);

        await upsertBlogPost(story, {
          titleEn: story.title,
          titleZh,
          contentEn: cleanedContentEn,
          contentZh,
          titleZhMinimax: titleZh,
          titleZhDoubao: null,
          titleTranslationScore: null,
          titleWinner: null,
          contentZhMinimax: contentZh,
          contentZhDoubao: null,
          contentTranslationScore: null,
          contentWinner: null
        });
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