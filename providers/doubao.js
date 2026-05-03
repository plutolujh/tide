// providers/doubao.js
// Doubao Provider 实现

import { readFileSync } from 'fs';

function loadEnv() {
  const env = {};
  try {
    readFileSync('.env', 'utf8').split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        const val = line.substring(idx + 1).trim();
        env[key] = val;
      }
    });
  } catch (err) {
    console.error('   [Doubao env error]:', err);
  }
  return env;
}

const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const MODEL = 'doubao-seed-2-0-pro-260215';

export class DoubaoProvider {
  async complete(prompt, systemPrompt = '') {
    const env = loadEnv();
    const API_KEY = env.DOUBAO_API_KEY;

    if (!API_KEY) {
      throw new Error('DOUBAO_API_KEY is not set in .env');
    }

    try {
      const inputContent = systemPrompt
        ? [{ type: 'input_text', text: systemPrompt + '\n\n' + prompt }]
        : [{ type: 'input_text', text: prompt }];

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          input: [
            {
              role: 'user',
              content: inputContent
            }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = JSON.parse(await response.text());

      // 提取返回的 text
      let textOutput = '';
      for (const block of data.output?.[0]?.content || []) {
        if (block.type === 'output_text') {
          textOutput += block.text;
        }
      }

      return textOutput.trim().slice(0, 1000);
    } catch (err) {
      console.error('   [Doubao error]:', err);
      return null;
    }
  }
}
