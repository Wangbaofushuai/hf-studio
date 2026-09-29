# 即梦画布 CLI「AI 直出」制作方式设计

> 日期：2026-09-29
> 状态：**已确认并实施**（Phase 1 单条直出、Phase 2 分镜级直出均已真实 E2E 验收，2026-09-29）
> 范围：新增第二种制作方式——复用 0–3 步（brief/design/storyboard/TTS），第 4–6 步按模式分流：即梦画布 CLI 逐 beat 生成视频片段，拼接 + 可选字幕烧录成片

## 1. 背景与目标

现状：HF-Studio 只有一种制作方式——LLM 写 HTML 合成（HyperFrames 渲染），图表/文字类视频稳定，但没有实拍感素材。

目标：接入**即梦画布 CLI（`dreamina-canvas`）**，让"直接生成视频"成为可选项：

- 向导里选「制作方式」：代码渲染（现有） / AI 直出（即梦）
- AI 直出复用 0–3 步的创意链路与 TTS；4–6 步生成分镜片段、拼接、烧字幕
- 旁白可选（沿用现有 `voiceover`/`subtitles` 开关语义）
- **尽量不碰宿主**：CLI 装进项目目录，运行态（登录态/任务记录）收进项目数据目录

> 文档依据：用户提供的《即梦画布 CLI 使用指南》（Lark）。注意与旧版 `dreamina` CLI 区分——指南明确旧命令（`dreamina text2image` 等）不适用于画布 CLI；本设计以 `dreamina-canvas` 命令面为准（命令/参数仍以安装后 `schema`、`--help` 实测为准）。

## 2. 关键事实（来自指南 + 安装脚本实测）

| 项 | 结论 |
|----|------|
| 安装 | `curl -fsSL https://jimeng.jianying.com/canvas-cli/install.sh \| bash`（本机可访问；脚本不含 shell 配置写入） |
| 自定义目录 | 支持 `DREAMINA_CANVAS_INSTALL_DIR`（二进制）与 `DREAMINA_CANVAS_SKILL_DIR`（Skill），可全部装进项目 |
| 登录 | `auth login`（交互）/ `--non-interactive auth login`（返回授权信息即退出，适合服务器）/ `auth wait --device-code`（等待授权）/ `auth account`（自检） |
| 视频 | `node create video --mode t2v / m2v / first_last_frame`，`--model/--ratio/--resolution/--duration/--ref/--run/--wait`；无 `i2v` |
| 音频 | `voice list` + `node create audio --mode tts --voice-name`（可替代/补充 Edge-TTS） |
| 任务 | 异步：`--run` 提交 → `operation status/wait <submitId>`；`resource get/download` 取产物 |
| 积分 | 生成消耗积分；**退出码 10 = 等待确认报价**（非失败）；可设积分上限，超限停止 |
| 退出码 | 0 成功 / 2 参数错 / 10 待确认 / 11 需登录 / 12-13 权限或版本 / 20 等待超时（任务可续查）/ 21-22 服务失败或需人工 |
| 恢复 | 必须保存 `projectId/nodeId/submitId/resourceId`；**超时不重复提交**，用原 ID 续查 |
| 结构化 | 安装脚本使用 `--format json version`，说明支持 JSON 输出；错误含 `requiredAction` |

## 3. 总体方案

### 3.1 数据模型（`types.ts`）

```ts
type JobMode = "hyperframes" | "jimeng";        // 默认 hyperframes（兼容老任务）

interface JobConfig {
  mode?: JobMode;                                // 新增
  jimeng?: {                                     // 新增（mode=jimeng 时生效）
    model?: string;                              // `model list --type video` 返回值；缺省用配置默认
    resolution?: "720p" | "1080p";               // 缺省 720p（省钱档）
    creditCap?: number;                          // 单任务积分上限（可选；超过则暂停等人工确认）
    clipMaxSec?: number;                         // 单片段时长上限（随模型；缺省 10）
  };
  // voiceover / subtitles 语义不变：旁白可选、字幕跟随旁白
}
```

- 无配音（`voiceover=false`）：beat 时长用 STORYBOARD 估算值，跳过 TTS/字幕
- 有配音：沿用 step3 的旁白与词级时间轴；beat 窗口即片段目标时长
- 片段原声（Phase 0 实测自带 AAC 音频轨）：旁白关闭 → 直接保留原生声音；旁白开启 → 默认把片段原声压到 0.2 做底（Phase 1 实现计划定稿，做成可配置）

### 3.2 步骤分流（StepId 0–6 不变，按 mode 分支）

| 步 | hyperframes 模式（现状不变） | jimeng 模式（新增） |
|----|------------------------------|----------------------|
| 0–2 | parse / design / storyboard | **完全复用**（step2 追加约束：单 beat ≤ `clipMaxSec`） |
| 3 | 全局 narration.wav + transcript | **复用**（旁白可选；无旁白则跳过） |
| 4 生成 | LLM 写 `compositions/*.html` + lint 门 | 逐 beat 调即梦生成视频 → 下载到 `jimeng/clips/beat-N.mp4` |
| 5 校验 | HyperFrames check + 快照 | ffprobe 门（存在/时长≥beat 窗口/视频流）+ 首帧快照 |
| 6 成片 | render + 字幕烧录 | ffmpeg 归一化拼接 + 混旁白 + 字幕烧录 + probe 门 |

断点续跑沿用现有引擎语义；**重跑 step4 时先查已保存 submitId 的任务状态，绝不重复提交**。

### 3.3 片段时长对齐

- 目标时长 = beat 窗口（有配音来自 transcript 边界；无配音来自估算）
- 请求时长 = clamp(ceil(beat 窗口), 模型下限 4s, `clipMaxSec`)
- 片段比窗口长 → 拼接时 `trim` 到精确窗口；短于窗口 → 该 beat 判失败并重试（重试仍短则失败）
- beat 窗口 > `clipMaxSec`：step2 提示词约束拆分（后续如需支持长 beat，再引入"同 beat 多片段拼接"）

### 3.4 积分与报价确认（两档）

1. **预设上限**（首选）：向导可填 `creditCap`；step4 报价 ≤ 上限 → 自动继续
2. **人工确认**（兜底）：未设上限或报价超限 → 任务暂停为 `needs_review`，JobDetail 显示报价卡片，「确认继续」后恢复该步执行

> `creditCap`/自动确认对应的 CLI 参数在 Phase 0 用 `--help`/`schema` 实测确定；本设计不假设参数名。

### 3.5 登录（服务器无桌面）

- 后端：`auth login --non-interactive` → 解析授权链接/验证码 → 返回前端展示；随后 `auth wait --device-code` 等待；完成后 `auth account` 自检
- 前端：Channels 页新增「即梦账号」卡片（状态 / 开始登录 / 重登 / 退出）
- Phase 0/1 可先由助手在终端发起、把链接与验证码发给用户完成授权

### 3.6 CLI 适配层（新模块 `server/src/jimeng/`）

| 文件 | 职责 |
|------|------|
| `cli.ts` | 定位二进制（`HF_JIMENG_BIN` → 项目 `.tools/...` → PATH）、注入运行环境（`XDG_CONFIG_HOME` 指向项目内）、超时、JSON 解析 |
| `auth.ts` | login start / wait / account / status |
| `canvas.ts` | canvas create / resource upload / get / download |
| `video.ts` | node create video → quote → run → operation wait → resource download（返回结构化任务引用） |
| `errors.ts` | 退出码与 `requiredAction` 分类：`needs_confirmation` / `auth_required` / `retryable_wait_timeout` / `fatal` |
| `state.ts` | `jimeng/state.json` 读写：projectId/nodeId/submitId/resourceId/clip 路径/状态 |

所有 CLI 调用走 `--format json`（Phase 0 验证；无 JSON 时解析文本但不进入本设计承诺范围）。

### 3.7 零宿主安装（尽量不碰宿主）

```bash
DREAMINA_CANVAS_INSTALL_DIR="$REPO/hf-studio/.tools/dreamina-canvas/bin" \
DREAMINA_CANVAS_SKILL_DIR="$REPO/hf-studio/.tools/dreamina-canvas/skills" \
  bash -c "$(curl -fsSL https://jimeng.jianying.com/canvas-cli/install.sh)"
```

- `.tools/` 加入 `.gitignore`；不写 PATH、不改 shell 配置（安装脚本本身也不写）
- 运行态：CLI 子进程注入 `XDG_CONFIG_HOME=<project>/data/jimeng/config`（Phase 0 验证是否被尊重；不生效则退到 `HOME` 隔离并回报用户）
- vd 集成（安装/更新菜单项）留待 Phase 3

### 3.8 产物布局

```
data/projects/<id>/
  brief.json DESIGN.md STORYBOARD.md SCRIPT.md        # 0-2（复用）
  narration.wav transcript.json                        # 3（复用，可选）
  jimeng/state.json                                    # 即梦任务引用（续跑依据）
  jimeng/clips/beat-N.mp4                              # step4 下载的片段
  jimeng/canvas.json                                   # projectId + webUrl（便于到网页端复看）
  renders/output.mp4                                   # step6 最终成片
```

## 4. 前端改动

- 新建任务向导：新增「制作方式」选择（代码渲染 / AI 直出）；AI 直出显示模型、分辨率、`creditCap`（可选）；旁白/字幕沿用现有开关
- 任务详情：步骤文案按模式适配（"生成片段 / 校验片段 / 拼接成片"）；产物面板展示每个 beat 的片段与画布链接；报价确认卡片
- 类型与 API 同步（`web/src/types.ts`、`api.ts`）

## 5. 测试策略

- 单测（bun:test）：
  - CLI 适配：参数构造、JSON/退出码解析、`requiredAction` 分类
  - 状态机：超时不重复提交（用原 submitId 续查）、报价暂停与恢复
  - 拼接/混音/字幕时移：命令构造纯函数 + 汇编清单生成
  - 时长对齐：clamp/trim/拆分规则
- 假 CLI：`test/fixtures/fake-dreamina-canvas.sh`（可配置 JSON 与退出码，模拟 10/11/20/21）
- 集成：真实 ffmpeg 生成 1s 小片段 → 拼接/混音/字幕全链路
- E2E：Phase 1 真实生成 1 条（消耗积分，需用户先确认）；Phase 2 跑 2–3 beat 任务

## 6. 分阶段实施

| 阶段 | 内容 | 验收 |
|------|------|------|
| **Phase 0 侦察**（~1h） | 项目内安装 CLI；`auth login` 实测；`--help`/`schema`/`--format json` 摸清命令面；试生成 1 条 t2v（**消耗积分，先经你同意**）；验证 XDG 隔离 | 输出《命令面实测记录》（spec 附录），确认无宿主污染 |
| **Phase 1 单条直出** | `mode=jimeng` 最小链路：一条 t2v → 下载 → `renders/output.mp4`；无分镜/旁白/字幕；向导加"AI 直出（实验）"选项 | 真实产出一条可播放视频；适配层单测全绿 |
| **Phase 2 分镜级直出** | 逐 beat 生成（t2v，素材存在时 m2v）+ 时长对齐 + 拼接 + 旁白混音 + 字幕 + ffprobe 门 + 报价确认 + 登录卡片 + 断点续跑 | 端到端产出带旁白/字幕的成片；重跑不重复提交；后台队列稳定 |
| **Phase 3 可选** | 混合模式（按 beat 指定生成方式）、vd 集成安装/更新、模型/画质进阶选项 | 按需再定 |

## 7. 风险与待确认项

- **CLI 细节以实测为准**：命令参数、`--format json` 覆盖度、积分上限参数名 → Phase 0 补齐
- **积分消耗未知**：Phase 0 首条试生成后回报实际报价；默认 720p 低风险档
- **排队时长**：`operation wait` 超时按"继续查询"处理（退出码 20），不重提交
- **合规限制**：真人脸等可能被限制（以 CLI 返回为准）
- **XDG 隔离**：若 CLI 不读 `XDG_CONFIG_HOME`，登录态会落在 `~/.config`（需你重新决定是否接受）
- **模型能力映射**：`format` 9:16/16:9/1:1 → 模型支持的 `ratio`；不支持时回退并提示
- 现有代码渲染链路**不做任何行为变更**（模式分流，默认值不变）

## 8. 附录：命令面实测记录（2026-09-29 Phase 0）

> Phase 2 验收（2026-09-29）：4 段分镜任务全链路跑通（171 积分）——LLM 分镜 → 逐段即梦生成 → 拼接 + Edge-TTS 旁白混音 + 中文字幕；发现并修复字幕取色过暗问题（DESIGN.md 首个 HEX 可能是深色背景色，现跳过亮度 <0.2 的候选，详见 `subtitle/ass.ts`）

### 8.1 安装（项目内、零宿主，已验证）

```bash
DREAMINA_CANVAS_INSTALL_DIR="$REPO/hf-studio/.tools/dreamina-canvas/bin" \
DREAMINA_CANVAS_SKILL_DIR="$REPO/hf-studio/.tools/dreamina-canvas/skills" \
  bash -c "$(curl -fsSL https://jimeng.jianying.com/canvas-cli/install.sh)"
```

- 结果：`.tools/dreamina-canvas/bin/dreamina-canvas`（v1.0.1，public/cn）+ 官方 Skill（含 references/）
- 宿主核对：`~/.local/bin`、`~/.config`、`~/.agents/skills` 均无新增；安装脚本不写 shell 配置
- 运行态隔离（已验证）：`HOME=<proj>/data/jimeng/home`（凭据落 `~/.config/dreamina-canvas/instance-id`、`~/.local/share/dreamina_canvas_oauth_v2_<hash>/byted_cli_user_token.json`，均在项目内）+ `DREAMINA_CANVAS_STATE_DIR=<proj>/data/jimeng/state`

### 8.2 认证（全流程实测通过）

| 命令 | 结果 |
|------|------|
| `auth status` | `{loggedIn:false, profile:"default", region:"cn", authMode:"oauth"}` |
| `auth login --non-interactive` | `data.challenge:{deviceCode, userCode, verificationUri, verificationUriComplete, pollSeconds:1, expiresAt}` |
| `auth wait --device-code <code> --timeout 10m` | `status:"logged_in"` |
| `auth account` | `{userId, isVip:true, vipLevel:"artisan"}` |

### 8.3 生成链路（实测通过）

```
canvas create "名" --use          → data.project.{projectId, webUrl}
node create video（不带 --run）    → data.node.nodeId（status:"empty"，只保存不扣费）
node quote --node-id <id>         → data.{items:[{nodeId,maxCredits}], totalMaxCredits, confirmationRequired}
node run --node-id <id>           → data.items:[{nodeId, submitId, state:"accepted", resources:[{resourceId}]}]
operation wait <submitId> --project-id <pid> → state:"succeeded" + submission advice（不重提交）
resource download <rid> --output <dir>      → {path, size, sha256}（文件名 dreamina-<resourceId>.mp4）
```

- 关键 flag：`--run/--wait/--submit-id/--credit-token/--credit-ceiling/--timeout/--interval`
- 退出码 10（报价待确认）本次未触发（`confirmationRequired:false`）；实现按官方 envelope（`creditConfirmation.minimumCreditCeiling` + `partialData.items[]`）处理

### 8.4 视频模型清单（`model list --type video`，2026-09-29）

| model | t2v | m2v | first_last_frame | 分辨率 | 时长 | 备注 |
|-------|-----|-----|------------------|--------|------|------|
| seedance_2.5 | ✓ | ✓(≤50 refs) | ✓ | 480p/720p/1080p | 4–30s | 提示词 ≤15000 字 |
| seedance_2.5_draft | ✓ | ✓(≤50) | ✓ | 480p | 4–30s | 样片版（本次试生成用） |
| seedance_2.0_vip | ✓ | ✓(≤12) | ✓ | 720p/1080p/4k | 4–15s | |
| seedance_2.0_fast_vip | ✓ | ✓(≤12) | ✓ | 720p | 4–15s | |
| seedance_2.0_mini | ✓ | ✓(≤12) | ✓ | 720p | 4–15s | |
| seedance_pro_fast | ✓ | ✗ | ✓ | 720p/1080p | 5–10s | |
| wan_3.0 | ✓ | ✓(≤20) | ✓ | 720P/1080P | 4–15s | |
| minimax_h3 | ✓ | ✓(≤12) | ✓ | 768P/2K | 4–15s | |
| happyhorse_1.1 | ✓ | ✓(≤9) | ✓ | 720P/1080P | 4–15s | 比例最全 |

比例：各模型均含 16:9 / 9:16 / 1:1（对应本项目三种 format），其余比例按模型不同。

### 8.5 试生成验收（真实消耗 45 积分）

- 参数：`seedance_2.5_draft` / `t2v` / 16:9 / 480p / 5s；报价 `totalMaxCredits:45`、`confirmationRequired:false`
- 产物：`data/jimeng/smoke/dreamina-7f0d9b0a-e550-4c57-81a8-29f5a056461d.mp4`（6.77MB）
- ffprobe：h264 854×480、5.02s；**含 AAC 音频轨 5.06s**
- 结论：建画布→存节点→报价→运行→等待→下载 全链路通；**即梦片段自带声音**——旁白关闭时可直接保留原生音频，旁白开启时需选混音策略（默认：片段原声压低做底，Phase 1 实现计划定稿）
