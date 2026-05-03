// providers/doubao.js
// Doubao Provider implementation with retry and extended timeout

import { readFileSync } from 'fs';

const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const MODEL = 'doubao-seed-2-0-pro-260215';
const TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;

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
  async complete(prompt, systemPrompt = '') {
    const API_KEY = getEnv().DOUBAO_API_KEY;

    if (!API_KEY) {
      throw new Error('DOUBAO_API_KEY is not set in .env');
    }

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
          signal: AbortSignal.timeout(TIMEOUT_MS),
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

        let textOutput = '';
        for (const block of data.output || []) {
          if (block.type === 'message') {
            for (const content of block.content || []) {
              if (content.type === 'output_text') {
                textOutput += content.text;
              }
            }
          }
        }

        return textOutput.trim().slice(0, 1000);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 1000;
          console.error(`   [Doubao attempt ${attempt + 1} failed, retrying in ${delay}ms...]:`, err.message);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    console.error('   [Doubao error]:', lastError);
    return null;
  }
}