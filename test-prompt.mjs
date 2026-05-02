import { readFileSync } from 'fs';
const env = {};
readFileSync('.env', 'utf8').split('\n').forEach(line => {
  const idx = line.indexOf('=');
  if (idx > 0) env[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
});
const MINIMAX_API_KEY = env.CLAUDE_API_KEY;
const MINIMAX_API_URL = 'https://api.minimaxi.com/v1/chat/completions';

async function minimaxChat(prompt, systemPrompt = '') {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const response = await fetch(MINIMAX_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'MiniMax-M2.7', max_tokens: 2000, messages })
  });
  const data = JSON.parse(await response.text());
  let content = data.choices?.[0]?.message?.content || '';
  const thinkIdx = content.indexOf('');
  return (thinkIdx !== -1 ? content.substring(thinkIdx + 7) : content).trim();
}

// Test with system prompt
console.log('Test with system prompt:');
let r = await minimaxChat(
  'Write a 300+ character English summary of this article: The startup Goodfire released Silico, a mechanistic interpretability tool that helps researchers debug and understand how large language models work internally.',
  'You are a professional tech writer. Write clear, detailed summaries in plain English.'
);
console.log('Summary result:', r.substring(0, 200));

console.log('\nTranslate test:');
r = await minimaxChat(
  'Translate this sentence to simplified Chinese: The startup Goodfire released an AI debugging tool called Silico.',
  'You are a professional translator. Output ONLY the Chinese translation, nothing else.'
);
console.log('Translate result:', r.substring(0, 100));