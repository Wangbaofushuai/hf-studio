# AGENTS.md — 项目规则

> 本文件是 Grok 在本工作区（`/root/KaiFa/Vide/AG`）工作时的强制行为规则，每次会话自动加载，任务过程中始终生效。

## 1. 运行环境

- **操作系统**：Linux 服务器
- **部署方式**：通过 Codeg 部署，通过公网 IP 的 Web 界面与用户对话
- **GitHub 分发**：仓库 `https://github.com/Wangbaofushuai/hf-studio`（公开，SSH: `git@github.com:Wangbaofushuai/hf-studio.git`）
  - **一键安装到新主机**：`curl -fsSL https://raw.githubusercontent.com/Wangbaofushuai/hf-studio/master/install.sh | bash`
    （克隆到 `~/hf-studio`，创建 `/usr/local/bin/vd` 软链接；幂等，重复执行即更新）
  - vd 菜单含「3. 更新项目」（git pull + 重装依赖）；安装脚本支持 `HF_STUDIO_DIR`/`HF_STUDIO_REPO` 覆盖
  - push 用 SSH（本机 `~/.ssh/id_ed25519` 已授权）；**推送前确认无真实 key 混入**（config/channels/data 均 gitignored）
- **公网访问（重要）**：服务器有公网 IP（当前 `43.133.250.224`，可能变化，用 `hostname -I` 确认）。**用户通过公网 IP 访问部署的 Web 服务**，因此：
  - Web/API 服务必须监听 `0.0.0.0`（Vite `server.host`、`Bun.serve` 的 `hostname`），默认只绑 localhost 会导致公网打不开
  - 云安全组/防火墙需放行对外端口（HF-Studio 当前为 5173 前端、8787 API）
  - 新起 Web 服务时默认按公网可访问配置，并在交付时给出公网访问地址
  - 注意：无鉴权的 API 公网可达 = 持有 IP 者可调用（如消耗 LLM key），学习测试环境可接受，交付时提示用户
- **用途**：学习与测试环境，可以放心实验
- **工作区**：`/root/KaiFa/Vide/AG`，已初始化 git 仓库（分支 `master`，用 git 管理所有变更）
- **说明**：安全不是关注点（学习测试环境），但"不污染宿主机"与"目录整洁"两条规则仍然必须遵守

## 2. 宿主机保护（除非必要，不得污染宿主机）

原则：**默认只读写项目目录内和 `/tmp`；确有必要触碰宿主机时，先向用户说明再执行。**

- 所有文件写入、构建产物、临时文件默认只允许出现在：项目目录内 或 `/tmp` 下
- 不修改宿主机系统配置：`/etc/`、`/usr/`、systemd 服务、crontab、全局 shell 配置（如 `~/.bashrc`）、全局环境变量
- 不全局安装软件：不使用 `pip install`（无 venv）、`npm install -g`、`apt-get install` 等；Python 项目用项目内 `.venv`，Node 依赖装在项目内 `node_modules`
- 使用 Docker 等容器时用 `--rm` 等一次性策略，不遗留容器、镜像、卷
- 任务结束清理自己产生的临时文件、日志、下载物；不在 `~` 下创建散乱文件（`~/.grok` 是工具配置目录，除外）
- 确有必要进行系统级操作（装全局软件、改系统配置等）时，先向用户说明原因和影响再执行

## 3. 项目目录整洁（git 仓库规则）

- 工作区根目录保持整洁：只保留 `AGENTS.md`、`.gitignore`、`README`、源码目录等必要文件
- 每个任务 / 子项目在独立子目录中进行，文件不散落在根目录
- 临时、中间产物（构建缓存、日志、下载包）放入 `/tmp`，或项目内 `.tmp/`（已被 `.gitignore` 忽略）
- 任务完成后删除调试脚本、临时输出、无关日志
- `.gitignore` 维护合理：构建产物、依赖、临时文件一律不提交；`.gitignore` 有缺口时及时补充
- 提交规范：小步、原子的提交，提交信息清晰描述改动内容；文件命名语义化

## 4. 外部资源利用（Skills / MCP / 文档）

**每次任务开始前，先盘点可用外部资源，再动手，并在合适的时机调用、互相配合。**

1. **查看 Skills**：检查 `~/.grok/skills/` 目录和系统提示中的技能列表，确认与本任务相关的技能
2. **查看 MCP 工具**：用 `search_tool` 检索当前可用的 MCP 服务与工具（如 codeg-mcp）；调用前必须先获取工具 schema，绝不猜测参数
3. **查阅文档**：需要时阅读 `~/.grok/docs/user-guide/` 下的官方文档（配置、技能、沙箱等）

**技能在合适时机调用，可串联配合：**

| 场景 | 技能 |
|------|------|
| 创意、需求、设计类工作 | `brainstorming` |
| 多步骤实现前的规划 | `writing-plans` |
| 写代码 / 修 bug 的实现 | `test-driven-development`、`subagent-driven-development` |
| 遇到 bug、测试失败 | `systematic-debugging` |
| 声称完成之前 | `verification-before-completion` |
| 代码审查 | `requesting-code-review` / `receiving-code-review` |
| 多个独立任务并行 | `dispatching-parallel-agents` |
| 涉及 docx / xlsx / pptx | `officecli` 系列 |

## 5. 工作习惯

- 每次任务先确认目标与约束（环境、范围、产出），再动手
- 大改动先出计划，执行过程保持进度可见
- 任务完成前必须验证：运行测试、构建、检查输出，用证据说话，不空口声称完成
- 删除文件、`git push` 等不可逆或有外部影响的操作，先说明再执行

## 6. 项目概览（HF-Studio — HyperFrames 视频生成中台）

本仓库主体是 **HF-Studio**：把 HyperFrames（github.com/heygen-com/hyperframes）官方 7 步流水线变成**代码编排的确定性 Web 应用**。用户在浏览器填想法、传素材、选 LLM 模型 → 直接得到 MP4 中文解说视频。核心痛点是"LLM 输出质量波动"，用 每步校验门 + 自动重试 + LLM-as-Judge 质量评分 + 人工兜底 做稳定性工程化。

- **技术栈**：后端 bun + TypeScript + Hono（端口 8787，绑 `0.0.0.0`）；前端 React 19 + Vite + Tailwind（端口 5173，绑 `0.0.0.0`）；存储 SQLite + 磁盘产物
- **外部依赖**：Edge-TTS（配音）、hyperframes CLI（渲染，底层 FFmpeg + headless Chrome）、OpenAI 兼容 LLM API（DeepSeek / GLM / Qwen / OpenAI / Kimi 预设 + 前端 BYOK 自定义渠道）
- **完整设计文档**：`docs/superpowers/specs/2026-08-04-hf-studio-design.md`；管理工具 vd 的设计见 `docs/superpowers/specs/2026-08-05-vd-manager-design.md`

### 7 步流水线（`server/src/pipeline/steps/`）

| 步 | 模块 | 产物 | 校验门 |
|----|------|------|--------|
| 0 需求解析 | step0-parse | `brief.json` | 字段齐全 |
| 1 创意设计 | step1-design | `DESIGN.md` | Judge 评分 ≥ 阈值（不合格带反馈重生成，≤2 次） |
| 2 分镜+脚本 | step2-storyboard | `STORYBOARD.md` + `SCRIPT.md` | Judge + 结构校验 |
| 3 配音 | step3-tts | `narration.wav` + 词级 `transcript.json` | 音频非空、时长偏差 ≤30%（ffprobe 真实边界） |
| 4 构建 | step4-build | `compositions/*.html`（每 beat 一次独立 LLM 调用） | `hyperframes lint` 零错误（带报错重试 ≤3 次） |
| 5 验证 | step5-validate | 关键帧快照 `snapshots/*.png` | `hyperframes check` 零错误 |
| 6 渲染 | step6-render | `renders/output.mp4` | ffprobe 验时长/视频流 |

- 任务断点续跑：任一步失败停在失败步骤，解决后从该步继续；重跑某步后下游标记 stale 待重跑
- 提示词模板在 `server/src/prompts/`（txt），与代码分离、可编辑；内含**质量红线**（反平庸/反默认模板感），改提示词时保持
- 产物目录与官方 HyperFrames 项目一致，**产物即标准项目，可直接用官方 CLI 继续编辑，不被本中台锁死**

## 7. 项目目录结构

```
AG/                                  # git 仓库根（分支 master，GitHub: Wangbaofushuai/hf-studio）
├── AGENTS.md
├── install.sh                       # 一键安装脚本（curl|bash → ~/hf-studio + vd 软链接）
├── .gitignore                       # 根级：临时/依赖/构建产物
├── docs/superpowers/                # 设计与实施文档（日期前缀 YYYY-MM-DD-主题）
│   ├── specs/                       #   设计文档（已确认）
│   └── plans/                       #   实施计划（子代理执行用）
└── hf-studio/                       # 子项目根
    ├── vd.ts                        # 管理工具（vd：一条龙启动/停止/依赖检测，可 ln -s 到 /usr/local/bin/vd）
    ├── README.md                    # 完整架构说明 + 快速开始
    ├── bunfig.toml                  # bun 用官方 registry（绕过腾讯镜像 404）
    ├── package.json                 # 根脚本：dev:server / dev:web / test / e2e / test:vd
    ├── docs/environment.md          # 环境记录（bun/ffmpeg/Chrome 版本等）
    ├── server/                      # 后端（Hono + bun）
    │   ├── config.json              # 预设渠道配置（gitignored，无 key）
    │   ├── config.example.json      # 配置模板（入库，改名即用）
    │   ├── src/
    │   │   ├── index.ts             # 入口：绑 0.0.0.0:8787
    │   │   ├── api/server.ts        # REST + SSE 路由（/api/jobs、/api/channels、/api/voices…）
    │   │   ├── api/job-dto.ts
    │   │   ├── channels.ts          # 渠道管理（预设 + 自定义 BYOK，同名自定义优先）
    │   │   ├── config.ts
    │   │   ├── db/store.ts          # SQLite JobStore（jobs / step_runs）
    │   │   ├── llm/                 # LlmGateway（OpenAI 兼容，多 provider + 重试退避）
    │   │   ├── judge/               # LLM-as-Judge 评分器
    │   │   ├── pipeline/            # engine.ts 状态机 + steps/step0-6 + beat-timing + root-html
    │   │   ├── prompts/             # 提示词模板（parse/design/storyboard/build-beat/fix-beat/judge-rubric）
    │   │   ├── render/              # hyperframes CLI 封装（lint/check/snapshot/render）+ resolutions
    │   │   ├── tts/                 # Edge-TTS 服务
    │   │   └── util/                # ffprobe / clean-output
    │   ├── test/                    # bun:test（每 step 独立测试 + api/engine/judge/gateway 等）
    │   ├── scripts/e2e-smoke.ts     # 真实 E2E 冒烟
    │   └── bun.lock
    ├── web/                         # React 前端（中文界面）
    │   ├── src/
    │   │   ├── pages/               # NewJob（3 步向导）/ JobList / JobDetail / Channels
    │   │   ├── components/          # WizardSteps / ModelSelect / VoiceSelect / ArtifactPanel / ProgressSteps
    │   │   └── api.ts / types.ts / App.tsx / main.tsx / index.css
    │   ├── vite.config.ts           # 绑 0.0.0.0，/api 代理到 8787
    │   └── dist/                    # 构建产物（gitignored）
    ├── data/                        # 运行时数据（gitignored，新环境自动重建）
    │   ├── jobs.db                  # SQLite
    │   ├── channels.json            # 用户渠道 key（明文，gitignored）
    │   └── projects/<jobId>/        # 每任务完整产物（assets/ brief.json DESIGN.md STORYBOARD.md
    │                                #   SCRIPT.md transcript.json compositions/ snapshots/ renders/output.mp4）
    └── test/vd.test.ts              # vd 工具单元/集成测试
```

## 8. 项目内工作规则

### 常用命令（改动后按此验证）

| 场景 | 命令 |
|------|------|
| 服务端改动验证（必跑） | `cd hf-studio/server && bun test --timeout 60000 && tsc --noEmit` |
| 前端改动验证（必跑） | `cd hf-studio/web && bun run build`（类型检查 + 生产构建） |
| vd 工具改动 | `cd hf-studio && bun run test:vd` |
| 真实 E2E 冒烟（重大流水线/提示词改动后跑，需真实 key，约 14 分钟） | `cd hf-studio/server && bun run e2e` |
| 启动/停止项目 | 终端输入 `vd` → 菜单 1 启动 / 2 停止；状态 `.tmp/vd-state.json`，日志 `.tmp/logs/` |

### 服务、配置与数据

- **端口**：后端 8787、前端 5173，均绑 `0.0.0.0`（公网可访问 `http://<公网IP>:5173`，需云安全组放行）；新起服务默认按公网可访问配置
- **配置**：`server/config.json`（预设渠道，无 key，gitignored）+ `data/channels.json`（用户 key）→ 引擎合并；改配置以 `config.example.json` 为模板；旧版 `providers` 结构启动时自动迁移
- **密钥**：API key 明文存 SQLite / channels.json，学习测试环境可接受，交付时提示用户
- **数据**：`data/projects/<jobId>/` 是真实产物，**非确认不删**；`data/`、`.tmp/`、`node_modules/` 均 gitignored

### 架构与编码约定

- 新步骤：在 `pipeline/steps/` 建 `stepN-*.ts`（输入/执行/输出/校验门 四段式）并在 `steps/index.ts` 注册；每步独立可测
- 提示词改动：改 `src/prompts/*.txt`，保持现有质量红线与 CJK 字体约束；不改代码里的硬编码 prompt
- 渲染/字体：产物 HTML 强制 CJK 字体栈（`system-ui` 无中文字形会变方块字）；`@font-face` 由服务端注入
- 文档习惯：设计/计划写进 `docs/superpowers/specs|plans/`，文件名 `YYYY-MM-DD-主题.md`；已确认的 spec 才是实现依据
- 提交：小步、原子、信息清晰（参考现有历史，如 `feat:` / `fix:` / `test:` 前缀）

### 卫生

- 调试脚本（如 `server/.tmp-*.ts`）、临时输出用完即删，不留在仓库
- 完成任务后清理日志、构建中间产物；根目录保持整洁
