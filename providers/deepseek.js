// providers/deepseek.js
// DeepSeek Provider 实现

import { readFileSync } from 'fs';

let cachedEnv = null;

function getEnv() {
  if (cachedEnv) return cachedEnv;
  const env = {};
  try {
    cachedEnv = {};
    readFileSync('.env', 'utf8').split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        const val = line.substring(idx + 1).trim();
        cachedEnv[key] = val;
      }
    });
  } catch (err) {
    console.error('   [DeepSeek env error]:', err);
  }
  return cachedEnv;
}

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-pro';

export class DeepSeekProvider {
  async complete(prompt, systemPrompt = '') {
    const env = getEnv();
    const API_KEY = env.DEEPSEEK_API_KEY;

    if (!API_KEY) {
      throw new Error('DEEPSEEK_API_KEY is not set in .env');
    }

    try {
      const messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
          stream: false
        }),
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = JSON.parse(await response.text());
      const textOutput = data.choices?.[0]?.message?.content || '';

      return textOutput.trim().slice(0, 2000);
    } catch (err) {
      console.error('   [DeepSeek error]:', err);
      return null;
    }
  }
}
