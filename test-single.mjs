import { readFileSync } from 'fs';
const env = {};
readFileSync('.env', 'utf8').split('\n').forEach(line => {
  const idx = line.indexOf('=');
  if (idx > 0) env[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
});
const SUPABASE_URL = env.SUPABASE_URL;
const ANON_KEY = env.SUPABASE_KEY;
const MINIMAX_API_KEY = env.CLAUDE_API_KEY;
const MINIMAX_API_URL = 'https://api.minimaxi.com/v1/chat/completions';
const JINA_API_URL = 'https://r.jina.ai/';

async function minimaxChat(prompt) {
  const response = await fetch(MINIMAX_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'MiniMax-M2.7', max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }] })
  });
  const data = JSON.parse(await response.text());
  let content = data.choices?.[0]?.message?.content || '';
  const thinkIdx = content.indexOf('');
  return (thinkIdx !== -1 ? content.substring(thinkIdx + 7) : content).trim();
}

async function googleTranslate(text) {
  // Placeholder - returns null to use MiniMax fallback
  return null;
}

async function translateToChinese(text) {
  const result = await minimaxChat(`Translate to Chinese: ${text}`);
  if (!result) return text;
  const m = result.match(/[\u4e00-\u9fff]{2,30}/);
  return m ? m[0].substring(0, 30) : text;
}

async function summarizeArticle(articleText) {
  const result = await minimaxChat('Write a detailed English summary, 300+ chars, plain prose:\n\n' + articleText.substring(0, 3000));
  if (!result) return null;
  const cleaned = result.replace(/^>\s*/gm, '').replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^- {1,3}/gm, '')
    .replace(/^[\s]*[-*_]{3,}\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length >= 200 ? cleaned.substring(0, 1000) : null;
}

async function translateSummary(summary) {
  const result = await minimaxChat(`Translate to Chinese. Only output Chinese, nothing else:\n${summary.substring(0, 1500)}`);
  if (!result) return null;
  const thinkIdx = result.indexOf('');
  let cleaned = thinkIdx !== -1 ? result.substring(thinkIdx + 7) : result;
  return cleaned.replace(/^[>\-—\s]+/, '').trim().substring(0, 800);
}

const url = 'https://www.technologyreview.com/2026/04/30/1136721/this-startups-new-mechanistic-interpretability-tool-lets-you-debug-llms/';
const title = "This startup's new mechanistic interpretability tool lets you debug LLMs";

console.log('Fetching article...');
const res = await fetch(JINA_API_URL + encodeURIComponent(url), { headers: { 'Accept': 'text/plain' } });
const text = (await res.text()).replace(/!\[([^\]]*)\]\([^)]+\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^#{1,6}\s*/gm, '').replace(/^\*\s/gm, '').replace(/^-\s/gm, '').replace(/\n{3,}/g, '\n\n').trim().substring(0, 3000);
console.log(`Article: ${text.length} chars\n`);

const titleZh = await translateToChinese(title);
console.log(`Title: ${title} → ${titleZh}`);

const contentEn = await summarizeArticle(text);
console.log(`EN summary: ${contentEn ? contentEn.length + ' chars: ' + contentEn.substring(0, 100) : 'FAILED'}...\n`);

const contentZh = await translateSummary(contentEn || '');
console.log(`ZH summary: ${contentZh ? contentZh.length + ' chars: ' + contentZh.substring(0, 100) : 'FAILED'}...`);