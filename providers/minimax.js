// providers/minimax.js
// MiniMax Provider 实现，封装现有 minimaxChat 逻辑

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

const API_KEY = env.MINIMAX_API_KEY;
const API_URL = 'https://api.minimaxi.com/anthropic/v1/messages';
const MODEL = 'MiniMax-M2.7';

export class MinimaxProvider {
  async complete(prompt, systemPrompt = '') {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2000,
          system: systemPrompt || 'You are a tech writer. Keep responses clear and direct.',
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = JSON.parse(await response.text());

      let textOutput = '';
      for (const block of data.content || []) {
        if (block.type === 'text') textOutput += block.text;
      }

      if (!textOutput) {
        for (const block of data.content || []) {
          if (block.type === 'thinking') {
            const m = block.thinking.match(/(?:Thus output:|So answer:|Output:)\s*"([^"]+)"/);
            if (m) return m[1];
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
}