# 设计文档：支持多 Provider 切换的翻译/摘要功能

**日期**: 2026-05-03
**状态**: 已批准
**更新**: 2026-05-03 - 增加翻译对比评分功能

---

## 1. 目标

在 `sync-hn.js` 中实现 Provider 抽象层，使摘要和翻译任务可以分别选择不同的 LLM Provider，支持灵活切换。同时实现 MiniMax / Doubao 双翻译对比，由 DeepSeek 作为裁判打分。

---

## 2. 架构

```
sync-hn.js
├── providers/
│   ├── minimax.js      # MiniMax Provider 实现
│   ├── doubao.js       # Doubao Provider 实现
│   ├── deepseek.js     # DeepSeek Provider 实现 (裁判)
│   └── index.js        # 统一导出，createProvider() 工厂函数
└── sync-hn.js          # 主逻辑
```

### Provider 接口

统一接口 `complete(prompt, systemPrompt) → string`：

```javascript
class LLMProvider {
  async complete(prompt, systemPrompt) { ... }
}
```

---

## 3. Provider 实现

### 3.1 MiniMax Provider (`providers/minimax.js`)

- **端点**: `https://api.minimaxi.com/anthropic/v1/messages`
- **认证**: `Authorization: Bearer {MINIMAX_API_KEY}`
- **模型**: `MiniMax-M2.7`
- **格式**: Anthropic 兼容格式

### 3.2 Doubao Provider (`providers/doubao.js`)

- **端点**: `https://ark.cn-beijing.volces.com/api/v3/responses`
- **认证**: `Authorization: Bearer {DOUBAO_API_KEY}`
- **模型**: `doubao-seed-2-0-pro-260215`
- **格式**: Ark API 格式（input 数组，content 混合类型）

### 3.3 DeepSeek Provider (`providers/deepseek.js`)

- **端点**: `https://api.deepseek.com/chat/completions`
- **认证**: `Authorization: Bearer {DEEPSEEK_API_KEY}`
- **模型**: `deepseek-v4-pro`
- **格式**: OpenAI 兼容 chat completions

---

## 4. 配置

### .env 配置项

```env
# 摘要用哪个 Provider (minimax / doubao)
SUMMARIZER_PROVIDER=minimax

# 翻译用哪个 (minimax / doubao / both)
# both = 同时跑两个，用于对比
TRANSLATOR_PROVIDER=both

# 裁判用哪个 Provider (deepseek)
JUDGE_PROVIDER=deepseek

# API Keys
MINIMAX_API_KEY=你的MiniMax_key
DOUBAO_API_KEY=你的豆包_key
DEEPSEEK_API_KEY=sk-edaaa522f8374ebcb3e8312bcee81294
```

---

## 5. 执行流程

```
fetchTopStories()
         │
         ▼
fetchArticleText()  ← Jina AI
         │
         ▼
summarizer.complete() → content_en (英文摘要)
         │
         ▼
┌───────────────────────────────────────┐
│  TRANSLATOR_PROVIDER=both 时并行执行   │
│                                       │
│  ├──→ translate_minimax → content_zh_minimax │
│  │                                     │
│  └──→ translate_doubao  → content_zh_doubao  │
└───────────────────────────────────────┘
         │
         ▼
    judge_deepseek (同时评判标题和内容)
         │
    输出: title_score, title_winner,
          content_score, content_winner
         │
         ▼
    title_zh = 胜出者
    content_zh = 胜出者
         │
         ▼
    upsertBlogPost() 存入所有字段
```

---

## 6. 数据库字段

### blog_posts 表字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `title_en` | text | 英文标题（不变） |
| `title_zh` | text | **胜出**的中文标题翻译（兼容旧数据） |
| `title_zh_minimax` | text | MiniMax 标题翻译 |
| `title_zh_doubao` | text | Doubao 标题翻译 |
| `title_translation_score` | integer | DeepSeek 评分 (0-100) |
| `title_winner` | text | `minimax` / `doubao` |
| `content_en` | text | 英文摘要（不变） |
| `content_zh` | text | **胜出**的中文内容翻译（兼容旧数据） |
| `content_zh_minimax` | text | MiniMax 内容翻译 |
| `content_zh_doubao` | text | Doubao 内容翻译 |
| `content_translation_score` | integer | DeepSeek 评分 (0-100) |
| `content_winner` | text | `minimax` / `doubao` |

---

## 7. Judge 提示词设计

DeepSeek 裁判同时评判标题和内容翻译质量：

```
system: "你是专业的翻译质量评审，给出0-100分并指出胜者。"

user: 标题英文原文: {title_en}
MiniMax翻译: {title_zh_minimax}
Doubao翻译: {title_zh_doubao}

内容英文原文: {content_en}
MiniMax翻译: {content_zh_minimax}
Doubao翻译: {content_zh_doubao}

请分别对标题和内容的翻译质量打分(0-100)，并指明每个维度的胜者。
输出格式:
TITLE_SCORE: X | TITLE_WINNER: minimax/doubao
CONTENT_SCORE: X | CONTENT_WINNER: minimax/doubao
```

---

## 8. 错误处理

- Provider 调用失败时，记录错误并返回 `null`
- 任一翻译器失败则跳过该文章
- Judge 失败时：所有字段存 null，旧字段（title_zh/content_zh）也存 null

---

## 9. 前端兼容性

- `title_zh`、`content_zh` 字段保留，前端无需修改
- 新的对比字段供未来扩展（如添加"查看对比"功能）

---

## 10. 可扩展性

- 新增 Provider：在 `providers/` 添加 `{name}.js`，实现 `complete()` 方法
- 新增维度：扩展 Judge 提示词即可

---

## 11. 实现步骤

1. 创建 `providers/` 目录
2. 实现 `providers/index.js`（工厂函数）
3. 实现 `providers/minimax.js`
4. 实现 `providers/doubao.js`
5. 实现 `providers/deepseek.js`
6. 修改 `sync-hn.js` 主逻辑
7. Supabase 手动新增字段（或 ALTER TABLE）
8. 测试不同组合