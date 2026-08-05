# HF-Studio — HyperFrames 视频生成中台

把 HyperFrames（github.com/heygen-com/hyperframes）7 步流水线变成**代码编排的确定性 Web 应用**：用户在浏览器里填想法、传素材、选模型，直接得到 MP4 解说视频。针对"LLM 输出质量波动"这一核心痛点，用每步校验门 + 自动重试 + LLM-as-Judge 质量评分 + 人工兜底做稳定性工程化。

完整设计文档见 [`docs/superpowers/specs/2026-08-04-hf-studio-design.md`](../docs/superpowers/specs/2026-08-04-hf-studio-design.md)（含 7 步流水线、四层质量防线、数据流与错误分级）。

## 架构

```
┌──────────────────────────────────────────────┐
│ 前端 React SPA（中文界面，Vite + Tailwind）    │
│  · 新建任务：想法 / 素材上传 / LLM 模型配置     │
│    / Edge-TTS 音色 / 时长 / 画幅 (9:16, 16:9…) │
│  · 任务列表 + 实时进度（SSE 推送）              │
│  · 任务详情：步骤时间线 + 产物预览 + 重生成按钮  │
└──────────────┬───────────────────────────────┘
               │ REST + SSE
┌──────────────▼───────────────────────────────┐
│ 后端 Node + TypeScript（bun 运行，端口 8787）  │
│  ┌────────────┐   ┌──────────────────────┐    │
│  │ API Server │   │ Pipeline Engine      │    │
│  │ (Hono)     │   │ 7 步状态机 + 单队列   │    │
│  └────────────┘   └──────┬───────────────┘    │
│   ┌───────────┬──────────┴───┬───────────┐    │
│ ┌─▼───┐  ┌────▼───┐  ┌──────▼───┐  ┌────▼──┐ │
│ │ LLM │  │ TTS    │  │ Render   │  │ Judge │ │
│ │Gate-│  │Service │  │ Service  │  │质量评  │ │
│ │way  │  │Edge-TTS│  │CLI 封装  │  │分器    │ │
│ └─────┘  └────────┘  └──────────┘  └───────┘ │
│  ┌────────────────────────────────────────┐   │
│  │ Job Store (SQLite) · 项目产物 (磁盘)    │   │
│  └────────────────────────────────────────┘   │
└───────────────────────────────────────────────┘
```

- **7 个 Step 模块**：`server/src/pipeline/steps/step0-parse … step6-render`，每步产出具名 artifacts + 该校步骤的校验门（结构化输出 / `hyperframes lint` / `check` / ffprobe 等）。
- **LLM Gateway**：OpenAI 兼容统一客户端（DeepSeek / GLM / Qwen / OpenAI 等），支持服务端内置渠道 + 前端 BYOK 自定义渠道合并（同名自定义渠道优先）。
- **Judge**：LLM-as-Judge 按评分卡对 DESIGN / STORYBOARD 打分，低于阈值带反馈自动重生成。
- **SQLite**：`data/jobs.db` 存 jobs / step_runs / 任务配置（含 BYOK key，明文，见「已知限制」）。

## 快速开始

前置环境：bun ≥ 1.3、FFmpeg + FFprobe、headless Chrome（`hyperframes browser ensure` 安装）、可访问 Edge-TTS 的网络。参见 [`docs/environment.md`](docs/environment.md)。

```bash
# 1. 安装依赖（server + web）
cd hf-studio/server && bun install
cd hf-studio/web && bun install

# 2. 启动后打开网页「模型渠道」页（/channels）填写 Key：
#    预设 DeepSeek / 智谱 GLM / 通义 Qwen / OpenAI / Kimi，填入各自 API Key 即用；
#    自定义渠道可自填 BaseURL 与模型。Key 存 data/channels.json（gitignored，不回显）。
#    （也支持直接编辑 data/channels.json；旧版 config.json 的 providers 会自动迁移）
```

`server/config.json`（gitignored，不入库）只放预设渠道定义（无 Key），默认模型可选：

```json
{
  "presetChannels": [
    { "id": "deepseek", "name": "DeepSeek", "baseURL": "https://api.deepseek.com/v1", "models": ["deepseek-chat", "deepseek-v4-flash"], "thinking": "disabled" }
  ],
  "defaults": { "model": "deepseek/deepseek-chat", "judgeModel": "deepseek/deepseek-chat", "judgeThreshold": 7 },
  "tts": { "defaultVoice": "zh-CN-XiaoxiaoNeural", "defaultLanguage": "zh-CN" }
}
```

```bash
# 3. 启动（两个终端，在 hf-studio/ 根目录；或直接用 vd 管理工具一条龙启动）
bun run dev:server   # 后端 :8787（绑 0.0.0.0，公网可访问）
bun run dev:web      # 前端 :5173（绑 0.0.0.0），/api 自动代理到 8787

# 4. 浏览器打开 http://localhost:5173（公网部署：http://<服务器公网IP>:5173，
#    需云安全组放行 5173/8787；用 `vd` 启动会在菜单里显示公网地址）
```

不配内置渠道也能用：新建任务页的「临时自定义渠道」（折叠区）可直接填 名称/BaseURL/Key/模型列表，随任务提交、按任务生效；长期使用建议在「模型渠道」页保存。

## 运行测试

```bash
cd hf-studio/server && bun run test   # 全部单元/集成测试（mock LLM，不需要真实 key）
cd hf-studio/web && bun run build     # 前端类型检查 + 生产构建
```

测试覆盖：7 个 step 的校验器与产物写入、LLM Gateway 重试逻辑、Judge 评分解析、beat 时长边界、API 层、状态机 7 步流转（mock transport）。

## E2E 冒烟

```bash
cd hf-studio/server && bun run e2e
```

真实 LLM + 真实 Edge-TTS + 真实 hyperframes 渲染，跑通 15 秒竖屏 demo，产出 `data/projects/<jobId>/renders/output.mp4`。

> ✅ **已实跑通过（2026-08-05）**：deepseek-v4-flash 渠道，7 步全绿，约 14 分钟产出 16.5s 竖屏视频（check 零错误）。
> 性能配置：非生成步骤用 `thinking: disabled`（快），beat/修复生成用 `thinking: enabled + reasoning_effort: low`（30 秒级、契约合规）。
> 未配置真实 key 时脚本立即 `exit 2` 提示，不会拿占位密钥请求。

## 产物目录

```
hf-studio/data/
├── jobs.db                      # SQLite：jobs / step_runs / 任务配置
└── projects/<jobId>/            # 每任务完整产物 —— 标准 HyperFrames 项目
    ├── assets/                  # 用户上传素材（按 job 隔离）+ 生成的配音
    ├── brief.json               # 步骤 0：需求要点（结构化）
    ├── DESIGN.md                # 步骤 1：视觉主题与色彩/字体规范
    ├── STORYBOARD.md            # 步骤 2：分镜
    ├── SCRIPT.md                # 步骤 2：旁白脚本
    ├── transcript.json          # 步骤 3：词级时间轴
    ├── assets/                  # 步骤 3：narration.wav + 每 beat 配音 + 上传素材
    ├── compositions/*.html      # 步骤 4：每 beat 一个 HTML composition
    ├── snapshots/*.png          # 步骤 5：check 通过后的关键帧快照
    └── renders/output.mp4       # 步骤 6：最终视频
```

产物目录结构与官方 HyperFrames 项目一致 —— **产物即标准项目，可直接用官方 CLI（`hyperframes`）继续编辑/渲染，不被本中台锁死**。任务支持断点续跑：任一步失败停在失败步骤，解决后从该步继续，下游步骤标记 stale 待重跑；详情页可对任意步骤「重新生成」或换模型重试。

## 已知限制

- **单队列串行**：任务逐个执行，本机渲染资源有限，先保稳定（多用户仅数据结构预留）。
- **本机渲染**：FFmpeg + headless Chrome 在服务器本地跑，不做云渲染（架构预留 workflow 扩展点）。
- **MVP 仅图文解说视频**：faceless explainer；slideshow / product-launch / motion-graphics 不在范围。
- **API key 明文存 SQLite**：学习测试环境可接受；多用户版需加密存储 + 前端渠道管理页。
- **BGM 不自动生成**：仅支持用户上传音频素材。
- **E2E 已实跑通过**：deepseek-v4-flash 渠道（见上）；换渠道/模型后建议重跑 `bun run e2e` 验收。

## 目录结构

```
hf-studio/
├── server/          # 后端：src/{api,pipeline,llm,tts,render,db,prompts}, test/, scripts/e2e-smoke.ts
├── web/             # React 前端（3 页：新建任务 / 任务列表 / 任务详情）
├── data/            # SQLite + 上传素材 + 项目产物（gitignored）
└── docs/            # environment.md
```
