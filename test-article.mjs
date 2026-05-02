import { readFileSync } from 'fs';
const env = {};
readFileSync('.env', 'utf8').split('\n').forEach(line => {
  const idx = line.indexOf('=');
  if (idx > 0) env[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
});
const MINIMAX_API_KEY = env.CLAUDE_API_KEY;
const MINIMAX_API_URL = 'https://api.minimaxi.com/v1/chat/completions';

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

const url = 'https://www.technologyreview.com/2026/04/30/1136721/this-startups-new-mechanistic-interpretability-tool-lets-you-debug-llms/';
console.log('Fetching article text...');
const res = await fetch('https://r.jina.ai/' + encodeURIComponent(url), { headers: { 'Accept': 'text/plain' } });
const text = await res.text();
const cleaned = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^#{1,6}\s*/gm, '').replace(/^\*\s/gm, '').replace(/^-\s/gm, '').replace(/\n{3,}/g, '\n\n').trim().substring(0, 3000);
console.log(`Article text: ${cleaned.length} chars`);
console.log(cleaned.substring(0, 300));
console.log('\n-- Summarizing --');
const summary = await minimaxChat('Write a detailed English summary, 300+ chars, plain prose:\n\n' + cleaned);
console.log(`Summary: ${summary.length} chars`);
console.log(summary.substring(0, 300));