# 渠道管理 + 前端质感升级设计文档

> 日期：2026-08-05
> 状态：已确认（用户逐项评审通过）
> 范围：服务端渠道存储重构 + 前端左侧导航/Apple 质感 + 模型渠道页

## 1. 目标

1. **渠道去绑定**：DeepSeek 等模型归到"预设渠道"，config.json 只含预设定义（无 key）；用户 Key 存服务端 `data/channels.json`（gitignored），前端「模型渠道」页填写。
2. **前端质感**：左侧固定导航栏 + Apple 质感（浅色 #f5f5f7 + 自动深色模式、毛玻璃、大圆角、柔和阴影、系统字体栈、分段选择器、渐变按钮）。
3. **模型渠道页**：6 张预设卡片（DeepSeek / 智谱 GLM / 通义 Qwen / OpenAI / Kimi / 自定义），填 Key、测试连通、自定义可增删。

## 2. 已确认决策

| 决策点 | 结果 |
|--------|------|
| Key 存储 | 服务端 `data/channels.json`（gitignored），换设备不重填 |
| 预设渠道 | DeepSeek + GLM + Qwen + OpenAI + Kimi + 自定义模板（共 6 个） |
| 任务渠道选择 | 前端选"已保存渠道"；临时 BYOK 随任务传渠道机制保留 |
| 深色模式 | 跟随系统（Tailwind v4 默认 media 策略） |

## 3. 服务端设计

### 3.1 config.json（纯预设，无 key）

```json
{
  "presetChannels": [
    { "id": "deepseek", "name": "DeepSeek", "baseURL": "https://api.deepseek.com/v1",
      "models": ["deepseek-chat", "deepseek-v4-flash"], "thinking": "disabled" },
    { "id": "glm", "name": "智谱 GLM", "baseURL": "https://open.bigmodel.cn/api/paas/v4",
      "models": ["glm-4.5", "glm-4.5-flash"] },
    { "id": "qwen", "name": "通义 Qwen", "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "models": ["qwen-plus", "qwen-turbo"] },
    { "id": "openai", "name": "OpenAI", "baseURL": "https://api.openai.com/v1",
      "models": ["gpt-4o", "gpt-4o-mini"] },
    { "id": "kimi", "name": "Kimi", "baseURL": "https://api.moonshot.cn/v1",
      "models": ["moonshot-v1-8k"] },
    { "id": "custom", "name": "自定义渠道", "baseURL": "", "models": [] }
  ],
  "defaults": { "model": "", "judgeModel": "", "judgeThreshold": 7 },
  "tts": { "defaultVoice": "zh-CN-XiaoxiaoNeural", "defaultLanguage": "zh-CN" }
}
```

### 3.2 data/channels.json（用户 key，gitignored）

```json
{ "deepseek": { "apiKey": "sk-..." },
  "custom": { "apiKey": "sk-...", "baseURL": "https://...", "models": ["..."] } }
```

### 3.3 新模块 `server/src/channels.ts`

- `loadChannelKeys(root)` / `saveChannelKey(root, id, {apiKey, baseURL?, models?})` / `deleteChannelKey(root, id)`
- `buildProviders(presets, keys)` → `LlmProvider[]`（预设定义 + key 合并；自定义渠道取 channels.json 的完整定义）
- `hasAnyKey(keys)` → 是否有至少一个可用渠道
- `migrateLegacyConfig()`：config.json 若为旧结构（`providers` 含 apiKey）→ key 迁入 channels.json、config.json 重写为 presetChannels 结构（一次性、幂等）

### 3.4 新 API

| 端点 | 行为 |
|------|------|
| `GET /api/channels` | `{ presets: [{id, name, baseURL, models, hasKey}], custom: [{...}] }`，**不回传 key** |
| `PUT /api/channels/:id` | body `{apiKey, baseURL?, models?}` → 保存（预设只存 key；custom 存完整定义） |
| `DELETE /api/channels/:id` | 清 key（预设）/ 删除（custom） |
| `GET /api/channels/:id/test` | 用该渠道 key 发一条最小请求 → `{ok, latencyMs}` 或 `{ok:false, error}` |

- `GET /api/models` 改为返回合并后的 providers（预设 + 已填 key 的渠道）
- 引擎 `baseProviders` 改为 `buildProviders(presetChannels, loadChannelKeys())`

### 3.5 迁移

- 现有 config.json 的 deepseek key → 自动迁入 channels.json；config.json 重写为预设结构
- e2e-smoke.ts 的 key 守卫改为"任一渠道有真实 key"（buildProviders 结果非空）

## 4. 前端设计

### 4.1 布局（App.tsx）

```
┌──────────┬─────────────────────────────┐
│ 左侧边栏  │  主内容区                    │
│ HF-Studio│  路由页面（新建/列表/详情/    │
│ ──────── │  模型渠道）                  │
│ 新建任务  │                             │
│ 任务列表  │                             │
│ 模型渠道  │                             │
│ ──────── │                             │
│ 版本号   │                             │
└──────────┴─────────────────────────────┘
```

- 固定宽度 ~240px，毛玻璃（`backdrop-blur-xl bg-white/70 dark:bg-black/40`）+ 右边框
- 路由高亮（`NavLink` active 样式：浅蓝底圆角）
- 深色模式：跟随系统（Tailwind v4 默认 media）

### 4.2 质感规范

- 背景：`#f5f5f7`（浅）/ `#000`（深）；卡片：白/黑 70% 毛玻璃、`rounded-2xl`、`shadow-lg shadow-black/5`
- 强调色：`#0071e3`；字体栈：`-apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif`
- 主按钮：渐变 `bg-gradient-to-b from-[#0a84ff] to-[#0071e3]` + hover 亮度
- 分段选择器（segmented）：画幅/时长/配音；输入框：圆角、细边框、focus 蓝环
- 任务卡片：状态彩色徽章（排队/生成中/失败/待处理/完成）

### 4.3 新建任务页（改造）

- 渠道选择改为**渠道卡片网格**：已填 key 的渠道高亮可选；未填的显示"未配置 Key → 去配置"（跳转 /channels）
- 模型下拉跟随所选渠道（默认首个模型）；自定义渠道的模型列表支持手填
- 保留「临时自定义渠道」折叠区（BYOK 机制）

### 4.4 新增「模型渠道」页（/channels）

- 每张预设卡片：渠道名、官方 baseURL（只读）、模型列表、Key 输入（password）、保存、测试连通（状态点：绿=通/红=失败/灰=未测）、已填状态徽章
- 自定义渠道：可新增（填名称/BaseURL/模型/Key）、可删除
- 保存后 toast/行内反馈

### 4.5 其他页面

- JobList：卡片列表 + 状态徽章 + 空态插画文案
- JobDetail：步骤时间线卡片化、视频圆角、快照网格圆角

## 5. vd 提示

- startFlow 启动前检查 `hasAnyKey`：无任何 key → 打印"请先到网页 http://<公网IP>:5173/channels 填写模型渠道 Key"

## 6. 测试

- 服务端单测：channels 存取/删除、buildProviders 合并（预设+key、自定义）、API CRUD（key 不回传断言）、migrateLegacyConfig 幂等
- 前端：构建通过 + 手动验收（浅/深色、渠道页保存/测试、新建任务选渠道）
- 回归：server 79 测试 + vd 7 测试全绿

## 7. 影响

- config.json 结构变更（自动迁移）；README/AGENTS.md 同步渠道管理说明
- 现有任务创建/运行不受影响（providers 合并逻辑兼容）
