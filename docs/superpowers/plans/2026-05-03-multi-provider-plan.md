# Multi-Provider Translation Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Provider 抽象层，支持 MiniMax/Doubao 双翻译对比，DeepSeek 裁判打分

**Architecture:** 通过工厂函数 `createProvider(type)` 动态加载 Provider，翻译时并行调用两个翻译器，DeepSeek 统一评判

**Tech Stack:** Node.js, Supabase REST API, MiniMax API, Doubao Ark API, DeepSeek API

---

## File Structure

```
refine-blog-frontend/
├── providers/
│   ├── index.js           # 工厂函数 createProvider(type)
│   ├── minimax.js         # MiniMax Provider 实现
│   ├── doubao.js          # Doubao Provider 实现
│   └── deepseek.js        # DeepSeek Provider 实现
├── sync-hn.js             # 主逻辑（修改）
├── .env                   # 配置（新增 DEEPSEEK_API_KEY 等）
└── docs/superpowers/plans/
    └── 2026-05-03-multi-provider-plan.md
```

---

## Task 1: Create providers directory and index.js

**Files:**
- Create: `providers/index.js`

```javascript
// providers/index.js
// 工厂函数，根据 type 返回对应 Provider 实例

const providers = {
  minimax: async () => {
    const { MinimaxProvider } = await import('./minimax.js');
    return new MinimaxProvider();
  },
  doubao: async () => {
    const { DoubaoProvider } = await import('./doubao.js');
    return new DoubaoProvider();
  },
  deepseek: async () => {
    const { DeepSeekProvider } = await import('./deepseek.js');
    return new DeepSeekProvider();
  }
};

export async function createProvider(type) {
  const Factory = providers[type];
  if (!Factory) throw new Error(`Unknown provider: ${type}`);
  return Factory();
}

export function isProviderAvailable(type) {
  return type in providers;
}
```

- [ ] **Step 1: Create providers directory**

```bash
mkdir -p providers
```

- [ ] **Step 2: Create providers/index.js with factory function**

```javascript
// providers/index.js
// 工厂函数，根据 type 返回对应 Provider 实例

const providers = {
  minimax: async () => {
    const { MinimaxProvider } = await import('./minimax.js');
    return new MinimaxProvider();
  },
  doubao: async () => {
    const { DoubaoProvider } = await import('./doubao.js');
    return new DoubaoProvider();
  },
  deepseek: async () => {
    const { DeepSeekProvider } = await import('./deepseek.js');
    return new DeepSeekProvider();
  }
};

export async function createProvider(type) {
  const Factory = providers[type];
  if (!Factory) throw new Error(`Unknown provider: ${type}`);
  return Factory();
}

export function isProviderAvailable(type) {
  return type in providers;
}
```

- [ ] **Step 3: Commit**

```bash
git add providers/index.js && git commit -m "feat: add providers directory with createProvider factory"
```

---

## Task 2: Create providers/minimax.js

**Files:**
- Create: `providers/minimax.js`

```javascript
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
```

- [ ] **Step 1: Create providers/minimax.js**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add providers/minimax.js && git commit -m "feat: add MinimaxProvider implementation"
```

---

## Task 3: Create providers/doubao.js

**Files:**
- Create: `providers/doubao.js`

```javascript
// providers/doubao.js
// Doubao Provider 实现

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

const API_KEY = env.DOUBAO_API_KEY;
const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const MODEL = 'doubao-seed-2-0-pro-260215';

export class DoubaoProvider {
  async complete(prompt, systemPrompt = '') {
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

      const data = JSON.parse(await response.text());

      // 提取返回的 text
      let textOutput = '';
      for (const block of data.output?.[0]?.content || []) {
        if (block.type === 'output_text') {
          textOutput += block.text;
        }
      }

      return textOutput.trim().substring(0, 1000);
    } catch (err) {
      console.error('   [Doubao error]:', err.message);
      return null;
    }
  }
}
```

- [ ] **Step 1: Create providers/doubao.js**

（同上）

- [ ] **Step 2: Commit**

```bash
git add providers/doubao.js && git commit -m "feat: add DoubaoProvider implementation"
```

---

## Task 4: Create providers/deepseek.js

**Files:**
- Create: `providers/deepseek.js`

```javascript
// providers/deepseek.js
// DeepSeek Provider 实现

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

const API_KEY = env.DEEPSEEK_API_KEY;
const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-pro';

export class DeepSeekProvider {
  async complete(prompt, systemPrompt = '') {
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
        })
      });

      const data = JSON.parse(await response.text());
      const textOutput = data.choices?.[0]?.message?.content || '';

      return textOutput.trim().substring(0, 2000);
    } catch (err) {
      console.error('   [DeepSeek error]:', err.message);
      return null;
    }
  }
}
```

- [ ] **Step 1: Create providers/deepseek.js**

（同上）

- [ ] **Step 2: Commit**

```bash
git add providers/deepseek.js && git commit -m "feat: add DeepSeekProvider implementation"
```

---

## Task 5: Refactor sync-hn.js to use providers

**Files:**
- Modify: `sync-hn.js`

**核心变更**：
1. 读取 `SUMMARIZER_PROVIDER`、`TRANSLATOR_PROVIDER`、`JUDGE_PROVIDER` 环境变量
2. 使用 `createProvider()` 创建 summarizer、translator（可能是同一个或两个）
3. 当 `TRANSLATOR_PROVIDER=both` 时，并行调用 minimax 和 doubao
4. DeepSeek judge 解析评分和胜者

```javascript
// sync-hn.js 关键变更片段

// 读取环境变量
const SUMMARIZER_PROVIDER = env.SUMMARIZER_PROVIDER || 'minimax';
const TRANSLATOR_PROVIDER = env.TRANSLATOR_PROVIDER || 'both';
const JUDGE_PROVIDER = env.JUDGE_PROVIDER || 'deepseek';

async function translateTitle(titleEn, minimax, doubao) {
  const [zhMinimax, zhDoubao] = await Promise.all([
    minimax.complete(`Translate to Chinese: ${titleEn}`, 'You are a professional translator.'),
    doubao.complete(`Translate to Chinese: ${titleEn}`, 'You are a professional translator.')
  ]);
  return { zhMinimax, zhDoubao };
}

async function translateContent(contentEn, minimax, doubao) {
  const [zhMinimax, zhDoubao] = await Promise.all([
    minimax.complete(`Translate to Chinese. Only output Chinese, nothing else:\n${contentEn.substring(0, 1500)}`, 'You are a professional translator.'),
    doubao.complete(`Translate to Chinese. Only output Chinese, nothing else:\n${contentEn.substring(0, 1500)}`, 'You are a professional translator.')
  ]);
  return { zhMinimax, zhDoubao };
}

async function judgeTranslations(titleEn, titleZhMinimax, titleZhDoubao, contentEn, contentZhMinimax, contentZhDoubao, judge) {
  const prompt = `标题英文原文: ${titleEn}
MiniMax翻译: ${titleZhMinimax}
Doubao翻译: ${titleZhDoubao}

内容英文摘要: ${contentEn.substring(0, 500)}
MiniMax翻译: ${contentZhMinimax.substring(0, 300)}
Doubao翻译: ${contentZhDoubao.substring(0, 300)}

请分别对标题和内容的翻译质量打分(0-100)，并指明每个维度的胜者。
输出格式:
TITLE_SCORE: X | TITLE_WINNER: minimax/doubao
CONTENT_SCORE: X | CONTENT_WINNER: minimax/doubao`;

  const result = await judge.complete(prompt, '你是专业的翻译质量评审，给出0-100分并指出胜者。');
  return parseJudgeResult(result);
}

function parseJudgeResult(result) {
  // 解析 "TITLE_SCORE: 85 | TITLE_WINNER: minimax"
  const titleMatch = result.match(/TITLE_SCORE:\s*(\d+)\s*\|\s*TITLE_WINNER:\s*(minimax|doubao)/i);
  const contentMatch = result.match(/CONTENT_SCORE:\s*(\d+)\s*\|\s*CONTENT_WINNER:\s*(minimax|doubao)/i);

  return {
    titleScore: titleMatch ? parseInt(titleMatch[1]) : null,
    titleWinner: titleMatch ? titleMatch[2].toLowerCase() : null,
    contentScore: contentMatch ? parseInt(contentMatch[1]) : null,
    contentWinner: contentMatch ? contentMatch[2].toLowerCase() : null
  };
}
```

- [ ] **Step 1: 修改 sync-hn.js**（完整重写主逻辑）
- [ ] **Step 2: Commit**

---

## Task 6: Update .env configuration

**Files:**
- Modify: `.env`

```env
SUMMARIZER_PROVIDER=minimax
TRANSLATOR_PROVIDER=both
JUDGE_PROVIDER=deepseek

MINIMAX_API_KEY=你的MiniMax_key
DOUBAO_API_KEY=你的豆包_key
DEEPSEEK_API_KEY=sk-edaaa522f8374ebcb3e8312bcee81294
```

- [ ] **Step 1: 更新 .env 配置**
- [ ] **Step 2: 不要提交 .env 到 git**

---

## Task 7: Supabase schema changes

**SQL to execute in Supabase SQL Editor:**

```sql
-- 新增翻译对比字段
ALTER TABLE blog_posts
ADD COLUMN IF NOT EXISTS title_zh_minimax text,
ADD COLUMN IF NOT EXISTS title_zh_doubao text,
ADD COLUMN IF NOT EXISTS title_translation_score integer,
ADD COLUMN IF NOT EXISTS title_winner text,
ADD COLUMN IF NOT EXISTS content_zh_minimax text,
ADD COLUMN IF NOT EXISTS content_zh_doubao text,
ADD COLUMN IF NOT EXISTS content_translation_score integer,
ADD COLUMN IF NOT EXISTS content_winner text;
```

- [ ] **Step 1: 在 Supabase SQL Editor 执行上述 SQL**
- [ ] **Step 2: 验证字段已添加**

---

## Task 8: Test different combinations

**测试命令：**

```bash
# 默认组合（MiniMax摘要 + 双翻译 + DeepSeek评判）
node sync-hn.js 3

# 纯豆包摘要 + 双翻译
TRANSLATOR_PROVIDER=doubao node sync-hn.js 3

# 纯豆包翻译（不用对比）
TRANSLATOR_PROVIDER=doubao node sync-hn.js 3
```

- [ ] **Step 1: 运行 sync-hn.js 测试**
- [ ] **Step 2: 检查 Supabase 数据库确认字段写入正确**
- [ ] **Step 3: 前端显示验证**

---

## Task 9: Cleanup test files

**Files:**
- Remove: `test-api.mjs`, `test-article.mjs`, `test-prompt.mjs`, `test-single.mjs`, `sync-hn.js.bak`

- [ ] **Step 1: 删除测试文件**
- [ ] **Step 2: Commit cleanup**

---

## 依赖关系

```
Task 1 (providers/index.js)
    ↓
Task 2 (minimax.js) ← Task 1 完成
Task 3 (doubao.js)  ← Task 1 完成  
Task 4 (deepseek.js) ← Task 1 完成
    ↓
Task 5 (sync-hn.js) ← Task 2,3,4 完成
    ↓
Task 6 (.env) ← 独立
Task 7 (Supabase) ← Task 5 后测试用
    ↓
Task 8 (测试) ← Task 6,7 完成
    ↓
Task 9 (清理) ← Task 8 完成
```

---

## 自查清单

- [ ] spec 覆盖：每个 spec 章节都能找到对应 task
- [ ] 无 placeholder：所有 "TBD"、"TODO" 已移除
- [ ] 类型一致：所有 Provider 的 `complete()` 方法签名一致
- [ ] 文件路径准确：所有路径与实际项目匹配
- [ ] 命令可执行：所有 pytest/npm 命令格式正确