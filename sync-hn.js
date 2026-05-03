/**
 * Hacker News Top 5 → Supabase blog_posts
 * Bilingual: English + Chinese titles and AI summaries
 *
 * Usage: node sync-hn.js
 *
 * Providers:
 * - SUMMARIZER_PROVIDER: minimax/doubao for summarizing articles
 * - TRANSLATOR_PROVIDER: minimax/doubao/both for translation
 * - JUDGE_PROVIDER: deepseek to score translations and determine winners
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
const JUDGE_PROVIDER = env.JUDGE_PROVIDER || 'deepseek';

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

async function upsertBlogPost(story, {
  titleEn,
  titleZh,
  contentEn,
  contentZh,
  titleZhMinimax,
  titleZhDoubao,
  titleTranslationScore,
  titleWinner,
  contentZhMinimax,
  contentZhDoubao,
  contentTranslationScore,
  contentWinner
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

  // Check duplicate by title_en OR original_url
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/blog_posts?or=(title_en.eq.${encodeURIComponent(titleEn)},original_url.eq.${encodeURIComponent(story.url)})&select=id`,
    { headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Prefer': 'representation' } }
  );
  let existing = [];
  try { existing = JSON.parse(await checkRes.text()); } catch (e) {}

  if (existing.length > 0) {
    console.log(`  [SKIP] Duplicate found: "${titleEn}" or URL ${story.url}`);
    return;
  }

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
  console.log(`[PROVIDERS] summarizer=${SUMMARIZER_PROVIDER}, translator=${TRANSLATOR_PROVIDER}, judge=${JUDGE_PROVIDER}`);

  const summarizer = await createProvider(SUMMARIZER_PROVIDER);
  const translator = TRANSLATOR_PROVIDER === 'both' ? null : await createProvider(TRANSLATOR_PROVIDER);
  const minimaxTranslator = await createProvider('minimax');
  const doubaoTranslator = await createProvider('doubao');
  const judge = await createProvider(JUDGE_PROVIDER);

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
      } catch (e) {}

      if (isDup) continue;

      const articleText = await fetchArticleText(story.url);
      if (!articleText) {
        console.log(`  No article text, skipping`);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      console.log(`  Article fetched (${articleText.length} chars), summarizing...`);

      // Step 1: Summarize article
      const contentEn = await summarizer.complete(
        `Write a detailed English summary, at least 300 characters, plain prose:\n\n${articleText.substring(0, 3000)}`,
        'You are a tech writer. Write clear, detailed summaries.'
      );

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
      let titleZhMinimax, titleZhDoubao, contentZhMinimax, contentZhDoubao;
      let titleZh, contentZh;

      if (TRANSLATOR_PROVIDER === 'both') {
        console.log(`  Translating title and content with both providers in parallel...`);

        // Parallel translation of content
        const [zhMinimax, zhDoubao] = await Promise.all([
          minimaxTranslator.complete(
            `Translate to Chinese. Only output Chinese, nothing else:\n${cleanedContentEn.substring(0, 1500)}`,
            'You are a professional translator.'
          ),
          doubaoTranslator.complete(
            `Translate to Chinese. Only output Chinese, nothing else:\n${cleanedContentEn.substring(0, 1500)}`,
            'You are a professional translator.'
          )
        ]);

        // Parallel translation of title
        const [titleZhMinimaxResult, titleZhDoubaoResult] = await Promise.all([
          minimaxTranslator.complete(
            `Translate to Chinese: ${story.title}`,
            'You are a professional translator. Output only the Chinese translation.'
          ),
          doubaoTranslator.complete(
            `Translate to Chinese: ${story.title}`,
            'You are a professional translator. Output only the Chinese translation.'
          )
        ]);

        titleZhMinimax = titleZhMinimaxResult;
        titleZhDoubao = titleZhDoubaoResult;
        contentZhMinimax = zhMinimax;
        contentZhDoubao = zhDoubao;

        console.log(`  Title MiniMax: ${titleZhMinimax?.substring(0, 30) || 'FAILED'}...`);
        console.log(`  Title Doubao: ${titleZhDoubao?.substring(0, 30) || 'FAILED'}...`);
        console.log(`  Content MiniMax: ${contentZhMinimax?.substring(0, 30) || 'FAILED'}...`);
        console.log(`  Content Doubao: ${contentZhDoubao?.substring(0, 30) || 'FAILED'}...`);

        // Step 3: Judge translation quality with DeepSeek
        console.log(`  Judging translations with DeepSeek...`);

        const judgePrompt = `标题英文原文: ${story.title}
MiniMax翻译: ${titleZhMinimax || 'N/A'}
Doubao翻译: ${titleZhDoubao || 'N/A'}

内容英文摘要: ${cleanedContentEn.substring(0, 500)}
MiniMax翻译: ${contentZhMinimax ? contentZhMinimax.substring(0, 300) : 'N/A'}
Doubao翻译: ${contentZhDoubao ? contentZhDoubao.substring(0, 300) : 'N/A'}

请分别对标题和内容的翻译质量打分(0-100)，并指明每个维度的胜者。
输出格式:
TITLE_SCORE: X | TITLE_WINNER: minimax/doubao
CONTENT_SCORE: X | CONTENT_WINNER: minimax/doubao`;

        const judgeResult = await judge.complete(judgePrompt, 'You are a professional translation evaluator.');
        console.log(`  Judge result: ${judgeResult}`);

        const { titleScore, titleWinner, contentScore, contentWinner } = parseJudgeResult(judgeResult || '');

        // Step 4: Select winners
        titleZh = titleWinner === 'minimax' ? titleZhMinimax : titleZhDoubao;
        contentZh = contentWinner === 'minimax' ? contentZhMinimax : contentZhDoubao;

        console.log(`  Title: ${story.title} → ${titleZh} (winner: ${titleWinner})`);
        console.log(`  Content ZH: ${contentZh?.substring(0, 60) || 'FAILED'}...`);

        await upsertBlogPost(story, {
          titleEn: story.title,
          titleZh,
          contentEn: cleanedContentEn,
          contentZh,
          titleZhMinimax,
          titleZhDoubao,
          titleTranslationScore: titleScore,
          titleWinner,
          contentZhMinimax,
          contentZhDoubao,
          contentTranslationScore: contentScore,
          contentWinner
        });

      } else {
        // Single translator mode
        console.log(`  Translating with ${TRANSLATOR_PROVIDER}...`);

        titleZh = await translator.complete(
          `Translate to Chinese: ${story.title}`,
          'You are a professional translator. Output only the Chinese translation.'
        );

        contentZh = await translator.complete(
          `Translate to Chinese. Only output Chinese, nothing else:\n${cleanedContentEn.substring(0, 1500)}`,
          'You are a professional translator.'
        );

        console.log(`  Title: ${story.title} → ${titleZh}`);
        console.log(`  ZH: ${contentZh?.substring(0, 60) || 'FAILED'}...`);

        // In single translator mode, store only one translation
        const titleZhMinimax = TRANSLATOR_PROVIDER === 'minimax' ? titleZh : null;
        const titleZhDoubao = TRANSLATOR_PROVIDER === 'doubao' ? titleZh : null;
        const contentZhMinimax = TRANSLATOR_PROVIDER === 'minimax' ? contentZh : null;
        const contentZhDoubao = TRANSLATOR_PROVIDER === 'doubao' ? contentZh : null;

        await upsertBlogPost(story, {
          titleEn: story.title,
          titleZh,
          contentEn: cleanedContentEn,
          contentZh,
          titleZhMinimax,
          titleZhDoubao,
          titleTranslationScore: null,
          titleWinner: null,
          contentZhMinimax,
          contentZhDoubao,
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