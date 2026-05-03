# 设计文档：支持多 Provider 切换的翻译/摘要功能

**日期**: 2026-05-03
**状态**: 已批准

---

## 1. 目标

在 `sync-hn.js` 中实现 Provider 抽象层，使摘要和翻译任务可以分别选择不同的 LLM Provider（当前：MiniMax / 豆包），支持灵活切换和扩展。

---

## 2. 架构

```
sync-hn.js
    ├── providers/
    │   ├── minimax.js      # MiniMax Provider 实现
    │   └── doubao.js       # Doubao Provider 实现
    └── sync-hn.js          # 主逻辑（读取配置，调用 Provider）
```

### Provider 接口

每个 Provider 实现统一接口 `complete(prompt, systemPrompt) → string`：

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
- **请求格式**: Anthropic 兼容格式

### 3.2 Doubao Provider (`providers/doubao.js`)

- **端点**: `https://ark.cn-beijing.volces.com/api/v3/responses`
- **认证**: `Authorization: Bearer {DOUBAO_API_KEY}`
- **模型**: `doubao-seed-2-0-pro-260215`
- **请求格式**: Ark API 格式（input 数组，content 混合类型）

---

## 4. 配置更新

`.env` 新增两个配置：

```env
SUMMARIZER_PROVIDER=minimax
TRANSLATOR_PROVIDER=doubao
```

`sync-hn.js` 启动时读取这两个值，动态导入对应 Provider。

---

## 5. 实现步骤

### Step 1: 创建 providers 目录和基础接口

- 创建 `providers/index.js` 作为统一导出入口
- 定义 `createProvider(type)` 工厂函数，根据配置返回对应 Provider 实例

### Step 2: 实现 MiniMax Provider

- 从现有 `sync-hn.js` 中提取 minimax 相关逻辑
- 封装为 `MinimaxProvider` 类
- 复用现有的错误处理和输出解析逻辑

### Step 3: 实现 Doubao Provider

- 创建 `providers/doubao.js`
- 实现 `complete()` 方法：
  - 构造 Ark API 格式请求
  - 处理 text 类型 content
  - 提取返回的 text 内容
- 错误处理与 MiniMax 保持一致

### Step 4: 修改 sync-hn.js

- 删除内联的 minimax 调用逻辑
- 读取 `SUMMARIZER_PROVIDER` 和 `TRANSLATOR_PROVIDER` 环境变量
- 使用 `createProvider()` 创建对应实例
- 调用 `summarizer.complete()` 和 `translator.complete()`

---

## 6. 数据流

```
环境变量
  ├── SUMMARIZER_PROVIDER=minimax
  └── TRANSLATOR_PROVIDER=doubao

sync-hn.js 启动
  → createProvider('minimax') → MinimaxProvider 实例
  → createProvider('doubao')  → DoubaoProvider 实例

执行时:
  articleText → summarizer.complete() → contentEn
  contentEn   → translator.complete() → contentZh
```

---

## 7. 错误处理

- Provider 调用失败时，记录错误并返回 `null`
- 上层逻辑检测到 `null` 则跳过该文章
- 两种 Provider 的错误格式统一处理

---

## 8. 测试验证

手动测试不同组合：
- MiniMax 摘要 + 豆包翻译
- 豆包摘要 + MiniMax 翻译
- 纯豆包 / 纯 MiniMax

---

## 9. 可扩展性

未来可添加新 Provider：
- 在 `providers/` 目录新增 `{name}.js` 文件
- 实现 `complete(prompt, systemPrompt)` 方法
- 在 `providers/index.js` 注册即可使用