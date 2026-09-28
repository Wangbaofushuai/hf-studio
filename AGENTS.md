# AGENTS.md — 项目规则

> 本文件是 AI 助手在本工作区（`/root/KaiFa/Vide/AG`）工作时的强制行为规则，每次会话自动加载，任务过程中始终生效。
>
> **每次任务开始前的固定动作**：① 确认目标与约束 → ② 盘点可用外部资源（Skills / MCP / 工具，见第 4 节）→ ③ 看一眼工作区状态（`git status`）与服务运行状态 → ④ 再动手；完成后按第 5 节用证据验证。

## 1. 运行环境

- **操作系统**：Linux 服务器；本机只有私网网卡（NAT 环境，`hostname -I` 返回 10.x/172.x），**公网 IP 必须动态查询**：`curl ifconfig.me`，或直接用 vd 内置 `publicIp()`（5 分钟缓存）。当前公网 IP `43.133.250.224`（可能变化，勿在代码里写死）
- **部署与对话方式**：项目部署在本机，**用户通过公网 IP 的 Web 界面与 AI 对话、访问服务**；AI 在本机以 root 运行
- **用途**：学习与测试环境，**安全不是关注点**——无需做鉴权/隔离等安全设计，公网可达的风险（如无鉴权 API 可被持有 IP 者调用、key 明文存储）已知并接受，交付时提示用户即可；但「不污染宿主机」（第 2 节）与「目录整洁」（第 3 节）两条必须遵守
- **GitHub 分发**：仓库 `https://github.com/Wangbaofushuai/hf-studio`（公开，SSH: `git@github.com:Wangbaofushuai/hf-studio.git`）
  - **一键安装到新主机**：`curl -fsSL https://raw.githubusercontent.com/Wangbaofushuai/hf-studio/master/install.sh | bash`
    （克隆到 `~/hf-studio`，创建 `/usr/local/bin/vd` 软链接；幂等，重复执行即更新）
  - vd 菜单含「3. 更新项目」（git pull + 重装依赖）；安装脚本支持 `HF_STUDIO_DIR`/`HF_STUDIO_REPO` 覆盖
  - vd 依赖检测：要求 node >= 22；检测 Chrome 运行库缺失（Ubuntu 24.04+ 为 `libasound2t64`，装前先询问用户）；`server/config.json` 缺失时自动从模板创建
  - push 用 SSH（本机 `~/.ssh/id_ed25519` 已授权）；**推送前确认无真实 key 混入**（config/channels/data 均 gitignored）
- **公网访问要求（重要）**：
  - Web/API 服务必须监听 `0.0.0.0`（Vite `server.host`、`Bun.serve` 的 `hostname`）；默认只绑 localhost = 公网打不开
  - 云安全组/防火墙需放行对外端口（HF-Studio 当前：前端 5173、API 8787）
  - 新起 Web 服务时默认按公网可访问配置，并在交付时给出公网访问地址（`http://<公网IP>:<端口>`）
- **运行状态查看**：终端输入 `vd`（菜单常驻 RUN/STOP 状态与访问地址）；状态文件 `hf-studio/.tmp/vd-state.json`，日志 `hf-studio/.tmp/logs/`

## 2. 宿主机保护（默认不污染；确有必要时由用户决定）

原则：**默认只读写项目目录内和 `/tmp`。任何可能影响宿主机的操作，先停下 → 向用户说明「要做什么、为什么必要、有什么影响」→ 由用户决定是否执行；用户未确认前不得执行。**

- 所有文件写入、构建产物、临时文件默认只允许出现在：项目目录内 或 `/tmp` 下
- 不修改宿主机系统配置：`/etc/`、`/usr/`、systemd 服务、crontab、全局 shell 配置（如 `~/.bashrc`）、全局环境变量
- 不全局安装软件：不使用 `pip install`（无 venv）、`npm install -g`、`apt-get install` 等；Python 项目用项目内 `.venv`，Node 依赖装在项目内 `node_modules`
- 使用 Docker 等容器时用 `--rm` 等一次性策略，不遗留容器、镜像、卷
- 任务结束清理自己产生的临时文件、日志、下载物；不在 `~` 下创建散乱文件（`~/.cache/opencode` 等工具配置目录，除外）
- **既有环境事实**（已完成、无需重复询问，见 `hf-studio/docs/environment.md`）：FFmpeg/FFprobe 已 apt 安装、Chrome Headless Shell 已下载到用户缓存、hyperframes CLI 在项目 `node_modules` 内；不要重装/改动这些

## 3. 项目目录整洁（git 仓库规则）

- 工作区根目录（`/root/KaiFa/Vide/AG`）只保留：`AGENTS.md`、`.gitignore`、`install.sh`、`docs/`、`hf-studio/`、`.superpowers/`（本地审查产物，自带 .gitignore，不入库）；其余一律不放
- 每个任务 / 子项目在独立子目录中进行，文件不散落在根目录
- 临时、中间产物（构建缓存、日志、下载包）放入 `/tmp`，或项目内 `.tmp/`（已被 `.gitignore` 忽略）
- 任务完成后删除调试脚本、临时输出、无关日志
- `.gitignore` 维护合理：构建产物、依赖、临时文件一律不提交；有缺口时及时补充
- 提交规范：小步、原子的提交，提交信息清晰描述改动内容；文件命名语义化

## 4. 外部资源盘点（Skills / MCP / 工具）——每次任务开始前必做

**原则：先盘点、再动手；合适的时机调用，互相配合；不猜工具名、不猜参数。**

1. **Skills（必看）**：每次任务先过一遍当前会话注入的可用技能列表（会随环境变化，不要假设与上次相同），用 `skill` 工具加载相关技能；没有直接匹配的也快速扫一眼确认
2. **MCP / 工具（必查）**：在 Code Mode 中用 `search()` 检索可用工具与 MCP 资源（如 `tools.opencode.list_mcp_resources`）；调用前先取 schema，绝不猜测参数；独立调用尽量并行
3. **项目文档（按需）**：`hf-studio/docs/environment.md`（环境事实）、`docs/superpowers/specs|plans/`（设计/计划）、`hf-studio/README.md`（架构）

**技能快照（以会话注入的 available_skills 为准，下表仅为本机当前清单；视频类任务一律从 `hyperframes` 入口开始）：**

| 场景 | 技能 |
|------|------|
| 任何视频/动画/动效的制作、编辑、渲染、诊断 | `hyperframes`（必读入口），按需配合 `hyperframes-core`、`hyperframes-cli` |
| 动画与运镜细节 | `hyperframes-animation`、`hyperframes-keyframes` |
| 音频混音 / 素材（BGM、音效、配音、图片） | `hyperframes-audio`、`media-use` |
| 现成视觉块（CRT、glitch、图表等） | `hyperframes-registry` |
| 创意/品牌/设计方向、Studio 时间线 | `hyperframes-creative`、`hyperframes-studio` |
| 具体题材：概念解说 / 产品宣传 / PR 讲解 / 动效短片 / 音乐卡点 | `faceless-explainer`、`product-launch-video`、`pr-to-video`、`motion-graphics`、`music-to-video` |
| 字幕 / 访谈播客图形包装 | `embedded-captions`、`talking-head-recut` |
| 幻灯片、Figma 导入、Remotion 迁移 | `slideshow`、`figma`、`remotion-to-hyperframes` |
| Office 文档、OpenCode 自身问题、上报 bug | `officecli`、`opencode`、`report` |

## 5. 工作习惯

- 每次任务先确认目标与约束（环境、范围、产出），再动手
- 大改动先出计划，执行过程保持进度可见
- 任务完成前必须验证：运行测试、构建、检查输出，用证据说话，不空口声称完成
- 删除文件、`git push` 等不可逆或有外部影响的操作，先说明再执行

## 6. 项目概览（HF-Studio — HyperFrames 视频生成中台）

本仓库主体是 **HF-Studio**：把 HyperFrames（github.com/heygen-com/hyperframes）官方 7 步流水线变成**代码编排的确定性 Web 应用**。用户在浏览器填想法、传素材、选 LLM 模型 → 直接得到 MP4 中文解说视频。核心痛点是"LLM 输出质量波动"，用 每步校验门 + 自动重试 + LLM-as-Judge 质量评分 + 人工兜底 做稳定性工程化。

- **技术栈**：后端 bun + TypeScript + Hono（端口 8787，绑 `0.0.0.0`）；前端 React 19 + Vite + Tailwind（端口 5173，绑 `0.0.0.0`）；存储 SQLite + 磁盘产物
- **外部依赖**：Edge-TTS（配音）、hyperframes CLI（渲染，底层 FFmpeg + headless Chrome）、OpenAI 兼容 LLM API（DeepSeek / GLM / Qwen / OpenAI / Kimi 预设 + 前端 BYOK 自定义渠道）
- **稳定性工程化**：固定并发 worker 池（默认 2，`HF_STUDIO_CONCURRENCY` 可调，FIFO 出队）+ 每步校验门 + 自动重试 + LLM-as-Judge 质量评分 + 人工兜底
- **字幕**：step6 渲染后用 ffmpeg ASS 烧录中文硬字幕（默认开启 `JobConfig.subtitles`，跟随 DESIGN 主题取色，无配音模式跳过，烧录失败不阻塞任务）
- **完整设计文档**：`docs/superpowers/specs/` 下共 7 份已确认 spec —— `2026-08-04-hf-studio-design.md`（主设计）、`2026-08-05-channels-ui-design.md`（模型渠道页）、`2026-08-05-newjob-wizard-cjk-font-design.md`（新建任务向导 + CJK 字体）、`2026-08-05-timing-themes-quality-design.md`（节奏/主题/质量）、`2026-08-05-vd-manager-design.md`（vd 管理工具）、`2026-08-12-concurrency-design.md`（固定并发 worker 池）、`2026-08-12-subtitles-design.md`（硬字幕烧录）；实施计划见 `docs/superpowers/plans/`

### 7 步流水线（`server/src/pipeline/steps/`）

| 步 | 模块 | 产物 | 校验门 |
|----|------|------|--------|
| 0 需求解析 | step0-parse | `brief.json` | 字段齐全 |
| 1 创意设计 | step1-design | `DESIGN.md` | Judge 评分 ≥ 阈值（不合格带反馈重生成，≤2 次） |
| 2 分镜+脚本 | step2-storyboard | `STORYBOARD.md` + `SCRIPT.md` | Judge + 结构校验 |
| 3 配音 | step3-tts | `narration.wav` + 词级 `transcript.json` | 音频非空、时长偏差 ≤30%（ffprobe 真实边界） |
| 4 构建 | step4-build | `compositions/*.html`（每 beat 一次独立 LLM 调用） | `hyperframes lint` 零错误（带报错重试 ≤3 次） |
| 5 验证 | step5-validate | 关键帧快照 `snapshots/*.png` | `hyperframes check` 零错误 |
| 6 渲染 | step6-render | `renders/output.mp4`（随后 ASS 烧录中文字幕） | ffprobe 验时长/视频流 |

- 任务断点续跑：任一步失败停在失败步骤，解决后从该步继续；重跑某步后下游标记 stale 待重跑
- 提示词模板在 `server/src/prompts/`（txt），与代码分离、可编辑；内含**质量红线**（反平庸/反默认模板感），改提示词时保持
- 产物目录与官方 HyperFrames 项目一致，**产物即标准项目，可直接用官方 CLI 继续编辑，不被本中台锁死**

## 7. 项目目录结构

```
/root/KaiFa/Vide/AG/                   # 本机工作区 = git 仓库根（分支 master；新主机安装时为 ~/hf-studio）
├── AGENTS.md                         # 本文件（项目规则）
├── install.sh                        # 一键安装脚本（curl|bash → ~/hf-studio + vd 软链接）
├── .gitignore                        # 根级：临时/依赖/构建产物
├── .superpowers/                     # 本地 SDD 审查产物（task brief/report、review diff；自带 .gitignore，不入库）
├── docs/superpowers/                 # 设计与实施文档（日期前缀 YYYY-MM-DD-主题）
│   ├── specs/                        #   设计文档（已确认）
│   │   ├── 2026-08-04-hf-studio-design.md
│   │   ├── 2026-08-05-channels-ui-design.md
│   │   ├── 2026-08-05-newjob-wizard-cjk-font-design.md
│   │   ├── 2026-08-05-timing-themes-quality-design.md
│   │   ├── 2026-08-05-vd-manager-design.md
│   │   ├── 2026-08-12-concurrency-design.md
│   │   └── 2026-08-12-subtitles-design.md
│   └── plans/                        #   实施计划（子代理执行用）
│       ├── 2026-08-04-hf-studio.md
│       ├── 2026-08-05-newjob-wizard-cjk-font.md
│       ├── 2026-08-05-timing-themes-quality.md
│       ├── 2026-08-12-concurrency.md
│       └── 2026-08-12-subtitles.md
└── hf-studio/                        # 应用子项目（HF-Studio 本体）
    ├── vd.ts                        # 管理工具（vd：启动/停止/更新/依赖检测，可 ln -s 到 /usr/local/bin/vd）
    ├── README.md                    # 完整架构说明 + 快速开始
    ├── bunfig.toml                  # bun 用官方 registry（绕过腾讯镜像 404）
    ├── package.json                 # 根脚本：dev:server / dev:web / test / e2e / test:vd
    ├── docs/environment.md          # 环境记录（bun/ffmpeg/Chrome 版本等）
    ├── .tmp/                        # 运行状态与日志（gitignored）：vd-state.json、logs/
    ├── server/                      # 后端（Hono + bun）
    │   ├── config.json              # 预设渠道配置（gitignored，无 key）
    │   ├── config.example.json      # 配置模板（入库，改名即用）
    │   ├── package.json / tsconfig.json / bun.lock
    │   ├── src/
    │   │   ├── index.ts             # 入口：绑 0.0.0.0:8787
    │   │   ├── types.ts             # 共享类型
    │   │   ├── api/                 # server.ts（REST + SSE）/ job-dto.ts
    │   │   ├── channels.ts          # 渠道管理（预设 + 自定义 BYOK，同名自定义优先）
    │   │   ├── config.ts
    │   │   ├── db/store.ts          # SQLite JobStore（jobs / step_runs）
    │   │   ├── llm/                 # gateway.ts（LlmGateway，多 provider + 重试退避）/ errors.ts
    │   │   ├── judge/               # LLM-as-Judge 评分器
    │   │   ├── pipeline/            # engine.ts 状态机 + steps/step0-6 + beat-timing + root-html
    │   │   ├── prompts/             # 提示词模板（parse/design/storyboard/build-beat/fix-beat/judge-rubric）
    │   │   ├── render/              # service.ts（hyperframes CLI 封装：lint/check/snapshot/render）+ resolutions.ts
    │   │   ├── tts/                 # Edge-TTS 服务
    │   │   ├── subtitle/            # ass.ts（ASS 字幕纯函数生成）+ burn.ts（ffmpeg 烧录）
    │   │   └── util/                # ffprobe / clean-output
    │   ├── test/                    # bun:test（每 step 独立测试 + api/engine/judge/gateway/store/tts/subtitle/
    │   │                            #   channels/smoke/beat-timing/root-html/render 等 + engine-concurrency
    │   │                            #   + fixtures/mock-transport.ts + e2e.config.sample.json）
    │   ├── scripts/e2e-smoke.ts     # 真实 E2E 冒烟
    │   └── bun.lock
    ├── web/                         # React 前端（中文界面）
    │   ├── src/
    │   │   ├── pages/               # NewJob（3 步向导）/ JobList / JobDetail / Channels
    │   │   ├── components/          # WizardSteps / ModelSelect / VoiceSelect / ArtifactPanel / ProgressSteps
    │   │   └── api.ts / types.ts / App.tsx / main.tsx / index.css
    │   ├── vite.config.ts           # 绑 0.0.0.0，/api 代理到 8787
    │   ├── index.html / package.json / tsconfig.json / bun.lock / .npmrc
    │   └── dist/                    # 构建产物（gitignored）
    ├── data/                        # 运行时数据（gitignored，新环境自动重建）
    │   ├── jobs.db                  # SQLite
    │   ├── channels.json            # 用户渠道 key（明文，gitignored）
    │   └── projects/<jobId>/        # 每任务完整产物（即标准 HyperFrames 项目，可用官方 CLI 继续编辑）：
    │                                #   brief.json DESIGN.md STORYBOARD.md SCRIPT.md transcript.json check.json
    │                                #   meta.json hyperframes.json package.json index.html
    │                                #   assets/ compositions/ snapshots/ renders/output.mp4
    └── test/vd.test.ts              # vd 工具单元/集成测试
```

## 8. 项目内工作规则

### 常用命令（改动后按此验证）

| 场景 | 命令 |
|------|------|
| 安装依赖 | `cd hf-studio/server && bun install`；`cd hf-studio/web && bun install` |
| 服务端改动验证（必跑） | `cd hf-studio/server && bun test --timeout 60000 && tsc --noEmit` |
| 前端改动验证（必跑） | `cd hf-studio/web && bun run build`（类型检查 + 生产构建） |
| vd 工具改动 | `cd hf-studio && bun run test:vd` |
| 真实 E2E 冒烟（重大流水线/提示词改动后跑，需真实 key，约 14 分钟） | `cd hf-studio/server && bun run e2e` |
| 手动启动（不用 vd） | `cd hf-studio && bun run dev:server`（:8787）/ `bun run dev:web`（:5173） |
| 启动/停止项目（推荐） | 终端输入 `vd` → 菜单 1 启动 / 2 停止 / 3 更新；状态 `.tmp/vd-state.json`，日志 `.tmp/logs/` |

### 服务、配置与数据

- **端口**：后端 8787、前端 5173，均绑 `0.0.0.0`（公网可访问 `http://<公网IP>:5173`，需云安全组放行）；新起服务默认按公网可访问配置
- **并发**：engine 固定并发 worker 池，默认 2（`HF_STUDIO_CONCURRENCY` 环境变量可调，钳制 ≥1）；FIFO 出队
- **配置**：`server/config.json`（预设渠道，无 key，gitignored）+ `data/channels.json`（用户 key）→ 引擎合并；改配置以 `config.example.json` 为模板；旧版 `providers` 结构启动时自动迁移
- **密钥**：API key 明文存 SQLite / channels.json，学习测试环境可接受，交付时提示用户
- **数据**：`data/projects/<jobId>/` 是真实产物，**非确认不删**；`data/`、`.tmp/`、`node_modules/` 均 gitignored

### 架构与编码约定

- 新步骤：在 `pipeline/steps/` 建 `stepN-*.ts`（输入/执行/输出/校验门 四段式）并在 `steps/index.ts` 注册；每步独立可测
- 提示词改动：改 `src/prompts/*.txt`，保持现有质量红线与 CJK 字体约束；不改代码里的硬编码 prompt
- 渲染/字体：产物 HTML 强制 CJK 字体栈（`system-ui` 无中文字形会变方块字）；`@font-face` 由服务端注入
- 字幕：改动走 `src/subtitle/ass.ts`（纯函数：样式取色优先级 主题 hue → DESIGN.md 首个 HEX → 兜底白色）与 `burn.ts`（ffmpeg `ass=` filter，需 libass/fontconfig）；默认开启、按 beat 整句、烧录失败只告警不判失败；无配音模式（`voiceover=false`）跳过
- 文档习惯：设计/计划写进 `docs/superpowers/specs|plans/`，文件名 `YYYY-MM-DD-主题.md`；已确认的 spec 才是实现依据
- 提交：小步、原子、信息清晰（参考现有历史，如 `feat:` / `fix:` / `docs:` / `test:` 前缀）

### 卫生

- 调试脚本（如 `server/.tmp-*.ts`）、临时输出用完即删，不留在仓库
- 完成任务后清理日志、构建中间产物；根目录保持整洁
