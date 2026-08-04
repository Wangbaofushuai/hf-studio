# HF-Studio 设计文档 — HyperFrames 视频生成中台

> 日期：2026-08-04
> 状态：已确认（用户逐段评审通过）
> 工作目录名：`hf-studio/`（可再命名）

## 1. 背景与目标

HyperFrames（github.com/heygen-com/hyperframes）是开源框架：写 HTML/CSS + 可 seek 动画 → 确定性 MP4。官方定义 7-step pipeline（Capture → Design → Strategy → Storyboard+Script → VO+Timing → Build → Validate），每步产出具名 artifacts。

当前使用方式是"Agent 对话"（带 skills 的编码 Agent 在终端里跑流水线），主要痛点是 **LLM 输出质量波动**：同样需求、不同模型/不同次生成，创意和质量忽高忽低。

**目标**：做一个 Web 应用中台（hf-studio），把 7-step pipeline 变成代码编排的确定性流程：

- 用户在前端输入想法文字 + 上传素材 + 配置 LLM 模型 → 直接得到 MP4 视频
- 非专业人员可用（表单化、无终端、无命令行）
- 模型可插拔（OpenAI 兼容 API 为主），质量不依赖某个特定模型
- 稳定性工程化：每步校验门 + 自动重试 + 质量评分 + 人工兜底

**非目标（MVP 明确不做）**：

- 账号体系/多用户（仅数据结构预留）
- 云渲染（HeyGen cloud/lambda 渲染），只本机渲染
- 除图文解说外的视频类型（slideshow / product-launch / motion-graphics 等，架构预留 workflow 扩展点）
- BGM 自动生成（音乐 API），仅支持用户上传音频素材
- 可视化时间线视频编辑器

## 2. 已确认的需求决策

| 维度 | 决定 |
|------|------|
| 核心痛点 | LLM 输出质量波动 → 质量门 + 重试机制 |
| 使用范围 | 先自用，预留多用户扩展（jobs.user_id 可空） |
| 渲染 | 本机（FFmpeg + headless Chrome，hyperframes CLI） |
| LLM 接入 | OpenAI 兼容 API 为主（DeepSeek / GLM / Qwen / OpenAI 等），provider 可配置 |
| TTS | Edge-TTS 为主（本地+云可配置思路），音色可选 |
| 视频类型 | MVP = 图文解说视频（faceless explainer） |
| 交互模式 | 默认全自动，中间产物（storyboard / 快照）网页可见、可重生成 |
| 架构方案 | 方案 A：流水线服务化（代码编排 + 每步直接调 LLM），预留演进到子代理并行 |

## 3. 总体架构

```
┌──────────────────────────────────────────────┐
│ 前端 React SPA（中文界面）                     │
│  · 新建任务：想法文字 / 素材上传 / LLM 模型配置 │
│    / Edge-TTS 音色 / 时长 / 画幅 (9:16,16:9…)  │
│  · 任务列表 + 实时进度（SSE 推送）              │
│  · 中间产物面板：storyboard / 快照 / 步骤日志   │
│    + 「重新生成此步」按钮                       │
└──────────────┬───────────────────────────────┘
               │ REST + SSE
┌──────────────▼───────────────────────────────┐
│ 后端 Node 22 + TypeScript（bun 运行）          │
│  ┌────────────┐   ┌──────────────────────┐    │
│  │ API Server │   │ Pipeline Engine      │    │
│  │ 参数校验/转发│   │ 7 步状态机 + 任务队列 │    │
│  └────────────┘   └──────┬───────────────┘    │
│     ┌───────────┬────────┴───┬────────────┐   │
│  ┌──▼───┐  ┌────▼───┐  ┌─────▼────┐  ┌────▼───┐
│  │ LLM  │  │ TTS    │  │ Render   │  │ Judge  │
│  │Gateway│  │Service │  │ Service  │  │(质量评分│
│  │多provider│ │Edge-TTS│  │CLI 封装  │  │ 器)    │
│  └──────┘  └────────┘  └──────────┘  └────────┘
│  ┌────────────────────────────────────────┐    │
│  │ Job Store (SQLite) · Media Store (磁盘) │    │
│  └────────────────────────────────────────┘    │
└───────────────────────────────────────────────┘
```

### 组件职责

1. **API Server** — 只有路由和参数校验，不藏业务逻辑。REST + SSE。
2. **Pipeline Engine** — 任务状态机：步骤 DAG、重试策略、干预操作（重跑某步、换模型重试）。不感知 LLM 细节。
3. **7 个 Step 模块**（`src/pipeline/steps/` 每步一目录）— 每步：入参 artifacts + 配置 → 产出 artifacts + 该校步骤的校验器。每步可独立运行、独立测试。
4. **LLM Gateway** — OpenAI 兼容统一客户端：provider 配置（baseURL / key / model / 温度等）、结构化输出解析、超时与重试退避、token 统计。
5. **TTS Service** — Edge-TTS 封装：音色列表、生成 wav。
6. **Render Service** — hyperframes CLI 子进程封装（init / tts / lint / check / snapshot / render），解析 stdout/stderr。
7. **Judge** — LLM-as-Judge 质量评分器：按评分卡打分，返回结构化评分 + 反馈意见。
8. **Job Store** — SQLite：`jobs`（预留 `user_id`）、`step_runs`（每次步骤执行完整记录：LLM 调用、校验结果、Judge 评分）。

### 项目布局

```
AG/
├── docs/superpowers/specs/2026-08-04-hf-studio-design.md
└── hf-studio/                    # 子项目根
    ├── server/                   # 后端
    │   ├── src/
    │   │   ├── api/              # REST + SSE
    │   │   ├── pipeline/         # 状态机 + steps/
    │   │   ├── llm/              # LLM Gateway
    │   │   ├── tts/              # Edge-TTS
    │   │   ├── render/           # hyperframes CLI 封装
    │   │   ├── db/               # SQLite 访问层
    │   │   └── prompts/          # skill 知识提炼的 prompt 模板（与代码分离）
    │   ├── test/
    │   └── package.json
    ├── web/                      # React 前端（Vite + Tailwind）
    ├── data/                     # SQLite + 上传素材 + 项目产物（.gitignore）
    └── docs/
```

技术选型理由：Node + TS 与 HyperFrames（TS monorepo）生态一致；bun 依赖安装快、子进程方便；SQLite 零运维、单文件备份；`jobs.user_id` 可空为多用户铺路。

## 4. 流水线步骤设计

7 步映射（每步 = 输入 + 执行 + 输出 + 校验门）：

| # | 步骤 | 输入 | 执行 | 输出 | 校验门 |
|---|------|------|------|------|--------|
| 0 | 需求解析 | 表单（想法/素材/配置） | LLM 提炼需求要点 | `brief.json` | 字段齐全（主题/时长/画幅/风格/是否配音） |
| 1 | 创意设计 | brief + 用户素材 | LLM 生成视觉主题与色彩/字体规范 | `DESIGN.md` | Judge 评分 ≥ 阈值（不合格自动重试） |
| 2 | 分镜+脚本 | DESIGN.md + brief | LLM 写 storyboard（beat 划分）+ 旁白脚本 | `STORYBOARD.md` + `SCRIPT.md` | Judge 评分 + 结构校验（beat 数、时长和） |
| 3 | 配音 | SCRIPT.md | Edge-TTS 按选中音色生成 | `narration.wav` + 词级 `transcript.json` | 音频非空、时长 > 0 且与脚本字数估算时长偏差 ≤ 30% |
| 4 | 构建 | storyboard + transcript + 素材 | 每 beat 一次独立 LLM 调用生成 HTML composition | `compositions/*.html` | `hyperframes lint` 零错误；不过带报错重试 |
| 5 | 验证 | compositions | `hyperframes check` + `snapshot` 关键帧截图 | 校验报告 + 快照 PNG | check 零错误；快照网页展示 |
| 6 | 渲染 | 全部 | `hyperframes render` | `output.mp4` | ffprobe 校验（时长≈预期、有视频流） |

### 关键决策

- **每 beat 独立 LLM 调用**（步骤 4）：每个 beat 的上下文只装自己那段 storyboard + 素材路径 + 动画规则；单 beat 失败只重跑该 beat；顺带解决长视频上下文超限。
- **prompt 知识来源**：从 HyperFrames skills（`hyperframes-core` composition 契约、`hyperframes-animation` 动画规则、`hyperframes-creative` 创意方向）提炼成静态 prompt 模板放 `src/prompts/`，与代码分离、可编辑。
- **干预点**：步骤 2 后（storyboard 面板，可改可重生成）、步骤 5 后（快照面板，可对单个 beat 重生成）。
- **断点续跑**：任何一步失败，任务停在失败步骤，解决后从该步继续，不重跑前面步骤。重跑某步后，下游步骤标记 `stale` 待重跑。
- **模型路由**：全局默认模型 + 每步可覆盖（如创意步骤用 GLM-4.5、构建步骤用 DeepSeek-V3）。

## 5. 质量控制系统（核心）

四层防线：

**第一层：输入侧控制**
- 每步 prompt 注入提炼后的 skill 知识，让不同模型产出趋同
- 关键步骤用结构化输出（JSON schema 强制字段），杜绝格式漂移
- 同一任务重试时 LLM 参数固定（温度/种子等保持一致）

**第二层：确定性硬门**
- 步骤 4：`hyperframes lint` 零错误才通过
- 步骤 5：`hyperframes check`（运行时错误、布局、动效）
- 步骤 6：ffprobe 验时长/视频流
- 硬门失败 → 带错误信息自动重试（最多 3 次），重试时把上次报错原文喂回 prompt

**第三层：LLM-as-Judge 软门**
- 步骤 1（DESIGN）、步骤 2（STORYBOARD/SCRIPT）产出由独立 Judge 按评分卡打分：信息清晰度、节奏、视觉丰富度、与需求匹配度
- 低于阈值 → 带 Judge 反馈自动重生成（最多 2 次），仍不合格停下交人工
- Judge 用与生成不同的模型（如生成 DeepSeek、评审 GLM），避免"自己评自己"

**第四层：人工门**
- 所有中间产物和 Judge 意见在网页可见
- 用户可「重新生成此步」或换模型后重试
- `step_runs` 全记录（LLM 调用、输出、校验、评分）→ 积累"哪个模型在哪个步骤质量稳定"的数据，为以后智能路由打基础

**重试总策略**：每步最多 3 次硬门重试 + 2 次 Judge 软门重生成；每次重试记录反馈。超限 → 任务 `needs_review`，前端亮提示，用户一键重试或换模型。

## 6. 数据流与错误处理

### 任务生命周期

```
queued → running → step0 → step1 → … → step6 → completed
              │                                │
              └── failed（停在失败步骤）         └── needs_review（重试超限）
```

- 任务串行执行（单队列），MVP 阶段本机渲染资源有限，先保稳定
- 步骤间通过磁盘 artifacts + `step_runs` 记录衔接
- 后端重启：`queued`/`running` 恢复为 `failed`，`needs_review` 保留

### 错误分级

| 错误类型 | 处理 |
|---------|------|
| LLM API 错误（超时/限流/4xx/5xx） | 自动重试 3 次（指数退避），仍失败 → failed，提示用户检查 key/模型 |
| 校验门失败 | 按第 5 节策略带反馈重试 |
| 渲染进程错误 | 解析 CLI 输出定位原因（缺 ffmpeg/素材路径错/超时），可重试，记录日志 |
| 素材问题（损坏/格式不支持） | 建任务时即校验，不让烂素材进入流水线 |

### 数据存储

- `data/jobs.db`（SQLite）：jobs / step_runs / 任务配置（模型、音色、参数）
- `data/projects/<job_id>/`：每任务完整产物目录（DESIGN.md、STORYBOARD.md、SCRIPT.md、narration.wav、compositions/、快照、MP4）。**结构与官方 HyperFrames 项目一致，产物即标准项目，可直接用官方 CLI 继续编辑，不被中台锁死**
- `data/uploads/`：用户上传素材，按 job 隔离

## 7. 前端页面（3 个）

1. **新建任务页**：表单（想法文字、素材上传、模型配置、音色选择、画幅、时长）
2. **任务列表页**：状态、进度、最近任务
3. **任务详情页**：步骤时间线 + 每步产物预览（storyboard 卡片、快照图、日志）+ 重生成/换模型重试按钮 + 最终视频播放

## 8. 测试策略

- 单元测试：每 step 校验器、LLM Gateway 重试逻辑、Judge 评分解析、状态机转换
- 集成测试：mock LLM 跑通 7 步状态流转
- 端到端冒烟：真实 LLM + 真实渲染跑 15 秒 demo 视频（每次改动后的验收标准）
- 前端：组件级测试 + 手动验收

## 9. 多用户扩展预留

- `jobs.user_id` 可空字段（现在恒空）
- 任务配置与产物按 job 隔离，天然支持按用户隔离
- API 层不绑定单用户假设；未来加认证时只需在 API Server 加中间件
