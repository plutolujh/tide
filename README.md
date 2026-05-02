# 潮汐 · Tides

A bilingual (English/Chinese) blog that automatically syncs Hacker News top stories, generates AI summaries, and displays them with language and theme switching.

---

## 功能特点

- **每日自动抓取** Hacker News Top 5 热榜文章
- **双语标题** — 英文原文 + 中文翻译
- **AI 摘要** — 英文 + 中文双语内容摘要（MiniMax-M2.7）
- **原文链接** — 保留原始文章 URL
- **语言切换** — 中文 / EN / All 三种显示模式
- **深浅主题** — Dark Mode / Light Mode
- **去重机制** — 按标题或 URL 检测已存在的文章

---

## 项目结构

```
refine-blog-frontend/
├── sync-hn.js          # HN 文章同步脚本（Node.js）
├── index.html           # 前端页面（纯静态）
├── .env                 # 环境变量（API keys）
└── README.md
```

---

## 环境配置

`.env` 文件内容：

```env
SUPABASE_URL=https://你的项目.supabase.co
SUPABASE_KEY=你的anon_key
CLAUDE_API_KEY=你的MiniMax_API_key
```

---

## 使用方法

### 同步文章（手动）

```bash
# 默认抓5条
node sync-hn.js

# 指定数量
node sync-hn.js 3
node sync-hn.js 10

# 定时循环（每小时自动运行）
node sync-hn.js 5 --loop=1

# 每6小时运行一次
node sync-hn.js 5 --loop=6
```

### 本地预览前端

```bash
# Python 简易服务器
python3 -m http.server 8888

# 或用 npx
npx serve .
```

然后打开 http://localhost:8888

---

## 数据库 Schema

`blog_posts` 表字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `title_en` | text | 英文标题 |
| `title_zh` | text | 中文标题 |
| `content_en` | text | 英文摘要 |
| `content_zh` | text | 中文摘要 |
| `original_url` | text | 原始文章链接 |
| `category_id` | uuid | 分类 ID |
| `created_at` | timestamp | 创建时间 |

---

## 定时任务（Crontab）

```bash
crontab -e

# 每天早上8点运行
0 8 * * * /usr/bin/node /path/to/sync-hn.js >> /tmp/sync-hn.log 2>&1

# 每6小时运行一次
0 */6 * * * /usr/bin/node /path/to/sync-hn.js >> /tmp/sync-hn.log 2>&1
```

---

## API 调用流程

```
HN Algolia API → Jina AI (提取文章内容)
                    ↓
              MiniMax-M2.7 (生成英文摘要)
                    ↓
              MiniMax-M2.7 (翻译成中文)
                    ↓
              Supabase (写入数据库)
```

---

## 前端功能

- **语言切换**：中文 / EN / All
- **主题切换**：Dark Mode / Light Mode
- **记忆偏好**：localStorage 保存用户选择
- **Read Original**：点击跳转到原始文章

---

## 技术栈

- **前端**：纯 HTML/CSS/JS（无框架）
- **数据库**：Supabase
- **AI**：MiniMax-M2.7 (Anthropic API 兼容格式)
- **内容提取**：Jina AI (r.jina.ai)
- **HN 数据**：Algolia HN API