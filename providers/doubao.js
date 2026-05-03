// providers/doubao.js
// Doubao Provider 实现

import { readFileSync } from 'fs';

const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const MODEL = 'doubao-seed-2-0-pro-260215';

// Cache env at module level
let cachedEnv = null;
function getEnv() {
  if (cachedEnv === null) {
    cachedEnv = {};
    try {
      readFileSync('.env', 'utf8').split('\n').forEach(line => {
        const idx = line.indexOf('=');
        if (idx > 0) {
          const key = line.substring(0, idx).trim();
          const val = line.substring(idx + 1).trim();
          cachedEnv[key] = val;
        }
      });
    } catch (err) {
      console.error('   [Doubao env error]:', err);
    }
  }
  return cachedEnv;
}

export class DoubaoProvider {
  async complete(prompt, systemPrompt = '', maxRetries = 2) {
    const API_KEY = getEnv().DOUBAO_API_KEY;

    if (!API_KEY) {
      throw new Error('DOUBAO_API_KEY is not set in .env');
    }

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
          signal: AbortSignal.timeout(60000),  // 60s timeout
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
        lastError = err;
        if (attempt < maxRetries) {
          console.error(`   [Doubao attempt ${attempt + 1} failed, retrying...]:`, err.message);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1));  // 1s, 2s delay
        }
      }
    }

    console.error('   [Doubao error]:', lastError);
    return null;
  }
}
