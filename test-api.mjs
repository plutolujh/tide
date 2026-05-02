import { readFileSync } from 'fs';
const env = {};
readFileSync('.env', 'utf8').split('\n').forEach(line => {
  const idx = line.indexOf('=');
  if (idx > 0) env[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
});
const MINIMAX_API_KEY = env.CLAUDE_API_KEY;
const MINIMAX_API_URL = 'https://api.minimaxi.com/anthropic/v1/messages';

async function minimaxChat(prompt, systemPrompt = '') {
  const response = await fetch(MINIMAX_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${MINIMAX_API_KEY}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'MiniMax-M2.7-highspeed',
      max_tokens: 2000,
      system: systemPrompt || 'You are a tech writer. Keep responses clear and direct.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = JSON.parse(await response.text());
  console.log('Content blocks:', JSON.stringify(data.content, null, 2));
  return '';
}

await minimaxChat('Write a summary: Goodfire released Silico, a tool for debugging AI models.');