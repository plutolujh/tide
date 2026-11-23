# 项目总结

## 项目概述
**潮汐 · Tides** - 多源新闻聚合博客

### 技术架构
- **前端**: 纯 HTML/CSS/JS，无框架
- **后端**: Supabase (数据库) + 多个 AI API (翻译/摘要)
- **部署**: VPS (Nginx) + Cloudflare CDN

### 数据源
| 来源 | 类型 |
|------|------|
| Hacker News | tech |
| TechCrunch | tech |
| The Verge | tech |
| Ars Technica | tech |
| 汽车之家 | 汽车 |
| BBC | 新闻 |

### 功能特性
- 中英双语内容
- 分类筛选 (tech/汽车/新闻)
- 语言切换 (中文/EN/All)
- 暗色/亮色主题
- 无限滚动加载
- 实时搜索

### 优化
- 30条帖子嵌入 HTML，首屏秒开
- Categories 数据嵌入，0 API 请求初始加载
- 初始加载 Loading 提示
- Let's Encrypt SSL 证书
- Cron 每3小时自动同步
- **posts.json 架构**：sync-all.js 生成 posts.json，index.html 静态壳加载 JSON，缓存友好

### 部署
- **网站**: https://hao123456.cn
- **博客**: https://blog.hao123456.cn
- **GitHub**: https://github.com/plutolujh/tide

### VPS 配置
- **系统**: Ubuntu
- **Web服务器**: Nginx (端口 80/443)
- **证书**: Let's Encrypt (Certbot)
- **项目目录**: /var/www/tide
- **Cron**: 每3小时执行 sync-all.js 并推送到 GitHub

### 最近修复
1. 正则表达式转义问题 (template literal)
2. Categories 懒加载嵌入
3. 初始加载提示
4. VPS .env 配置

### 最新功能：Sync 按钮 + posts.json 架构
**日期**: 2026-05-08

**功能说明**:
- 首页右上角添加 `Sync ↻` 按钮
- 点击后触发 sync-all.js 同步新闻内容
- 显示 "Syncing..." 状态，同步完成后自动刷新列表

**实现方案**:
1. **sync-server.js**: Express 服务，监听 `/api/sync` POST 请求
2. **认证机制**: Bearer Token (`SYNC_TOKEN`)
3. **Nginx 代理**: `/api/sync` → `http://localhost:3001`
4. **posts.json 架构**: sync-all.js 生成 posts.json，index.html 作为静态壳加载 JSON

**posts.json 架构优势**:
| 方面 | 说明 |
|------|------|
| 同步速度 | 快 — 只写 JSON 文件，不重写整个 HTML |
| 缓存 | 好 — index.html 长期缓存，只更新 posts.json |
| 加载 | fetch posts.json，失败回退到嵌入式数据 |

**文件变更**:
| 文件 | 说明 |
|------|------|
| sync-server.js | 新建 - 轻量同步触发服务 |
| index.html | 修改 - 添加 Sync 按钮和 posts.json 加载逻辑 |
| sync-all.js | 修改 - 生成 posts.json 替代重写 index.html |
| start.sh | 修改 - 添加 sync-server 启动命令 |
| .env | 添加 - `SYNC_TOKEN` 配置 |
| .gitignore | 添加 - posts.json |

### 部署
- **网站**: https://hao123456.cn
- **博客**: https://blog.hao123456.cn
- **GitHub**: https://github.com/plutolujh/tide

