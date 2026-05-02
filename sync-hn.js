/**
 * Hacker News Top 5 → Supabase blog_posts
 * Bilingual: English + Chinese titles and AI summaries
 *
 * Usage: node sync-hn.js
 */

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
const MINIMAX_API_KEY = env.CLAUDE_API_KEY;

const JINA_API_URL = 'https://r.jina.ai/';
const MINIMAX_API_URL = 'https://api.minimaxi.com/anthropic/v1/messages';
const MINIMAX_MODEL = 'MiniMax-M2.7';

const ANON_KEY = SUPABASE_KEY;
const HN_API = 'https://hn.algolia.com/api/v1';

async function fetchTopStories(count = 5) {
  const res = await fetch(`${HN_API}/search?tags=front_page&hitsPerPage=${count}`);
  const data = await res.json();
  return data.hits.filter(s => s.url).map(s => ({
    id: s.objectID, title: s.title, url: s.url,
    score: s.points || 0, by: s.author || 'unknown', descendants: s.num_comments || 0
  }));
}

async function fetchArticleText(url) {
  try {
    const res = await fetch(`${JINA_API_URL}${encodeURIComponent(url)}`, {
      headers: { 'Accept': 'text/plain' }
    });
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

async function minimaxChat(prompt, systemPrompt = '') {
  try {
    const response = await fetch(MINIMAX_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        max_tokens: 2000,
        system: systemPrompt || 'You are a tech writer. Keep responses clear and direct.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = JSON.parse(await response.text());

    // Collect text blocks (final output, not thinking)
    let textOutput = '';
    for (const block of data.content || []) {
      if (block.type === 'text') textOutput += block.text;
    }

    // If no text blocks, extract from thinking (for simple Q&A)
    if (!textOutput) {
      for (const block of data.content || []) {
        if (block.type === 'thinking') {
          // Find patterns like "Thus output: X" or "So answer: X"
          const m = block.thinking.match(/(?:Thus output:|So answer:|Output:)\s*"([^"]+)"/);
          if (m) return m[1];
          // For Chinese: find Chinese chars
          const cn = block.thinking.match(/[\u4e00-\u9fff]{2,30}/g);
          if (cn) return cn[cn.length - 1];
        }
      }
    }

    return textOutput.trim().substring(0, 1000);
  } catch (err) {
    console.error('   [MiniMax error]:', err.message);
    return null;
  }
}

async function translateToChinese(text) {
  const result = await minimaxChat(
    `Translate to Chinese: ${text}`,
    'You are a professional translator. Output only the Chinese translation.'
  );
  if (!result) return text;
  const m = result.match(/[\u4e00-\u9fff]{2,30}/);
  return m ? m[0].substring(0, 30) : text;
}

async function summarizeArticle(articleText) {
  const result = await minimaxChat(
    `Write a detailed English summary, at least 300 characters, plain prose:\n\n${articleText.substring(0, 3000)}`,
    'You are a tech writer. Write clear, detailed summaries.'
  );
  if (!result) return null;
  const cleaned = result
    .replace(/^>\s*/gm, '').replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^- {1,3}/gm, '').replace(/^[\s]*[-*_]{3,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length >= 200 ? cleaned.substring(0, 1000) : null;
}

async function translateSummary(summary) {
  const result = await minimaxChat(
    `Translate to Chinese. Only output Chinese, nothing else:\n${summary.substring(0, 1500)}`,
    'You are a professional translator.'
  );
  if (!result) return null;
  // Clean up any leading punctuation
  const cleaned = result.replace(/^[>\-—\s]+/, '').trim();
  return cleaned.length >= 50 ? cleaned.substring(0, 800) : null;
}

async function upsertBlogPost(story, titleEn, titleZh, contentEn, contentZh) {
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
    title_en: titleEn, title_zh: titleZh,
    content_en: contentEn, content_zh: contentZh,
    original_url: story.url,
    category_id: '9126cc45-ac4c-42de-aca8-175d51351ab2'
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
}

async function main() {
  const args = process.argv.slice(2);
  const countArg = args.find(a => !a.startsWith('--'));
  const count = countArg ? parseInt(countArg, 10) : 5;
  const loopHours = parseFloat(args.find(a => a.startsWith('--loop='))?.split('=')[1] || '0');
  const intervalMs = loopHours > 0 ? loopHours * 60 * 60 * 1000 : 0;

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

      const [articleText, titleZh] = await Promise.all([
        fetchArticleText(story.url),
        translateToChinese(story.title)
      ]);
      console.log(`  Title: ${story.title} → ${titleZh}`);

      let contentEn = '', contentZh = '';
      if (articleText) {
        console.log(`  Article fetched (${articleText.length} chars), summarizing...`);
        contentEn = await summarizeArticle(articleText);
        if (contentEn) {
          console.log(`  EN: ${contentEn.substring(0, 60)}...`);
          contentZh = await translateSummary(contentEn);
          console.log(`  ZH: ${contentZh ? contentZh.substring(0, 60) : 'FAILED'}...`);
        }
      } else {
        console.log(`  No article text, skipping`);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      await upsertBlogPost(story, story.title, titleZh, contentEn, contentZh);
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