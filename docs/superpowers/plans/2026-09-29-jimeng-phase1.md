# 即梦直出 Phase 1（单条直出）Implementation Plan

> **For agentic workers:** 按任务顺序执行，TDD（先写失败测试再实现），每任务完成后跑对应测试；提交由用户决定（本项目 AI 不自动提交）。

**Goal:** 新增 `mode="jimeng"` 最小链路——一句想法 → 一段即梦视频 → `renders/output.mp4`；不涉及分镜/旁白/字幕。

**Architecture:** 新增 `server/src/jimeng/`（CLI 适配层 + 服务状态机）；引擎 `Services`/`StepContext` 注入 JimengService；step0-3 在 jimeng 模式跳过，step4 生成、step5 probe 门、step6 产出成片；向导加"制作方式"，API 解析 `mode`。

**Tech Stack:** TypeScript + bun + 即梦画布 CLI（`.tools/dreamina-canvas/bin/dreamina-canvas`，v1.0.1）+ ffprobe + bun:test

## Global Constraints

- 遵循 spec：`docs/superpowers/specs/2026-09-29-jimeng-canvas-direct-video-design.md`（Phase 0 附录含实测命令面）
- 零宿主：所有 CLI 调用 `HOME=<proj>/data/jimeng/home`、`DREAMINA_CANVAS_STATE_DIR=<proj>/data/jimeng/state`；二进制 `HF_JIMENG_BIN` → `.tools/.../bin/dreamina-canvas`
- 积分纪律：先 `node quote`；`confirmationRequired=false` 或 `creditCap` 覆盖报价时才运行；否则报错交回用户（Phase 2 做确认 UI）
- 幂等：任何重跑复用已保存的 `projectId/nodeId/submitId`，**绝不重复提交**；`--credit-token` 不落盘
- 现有 hyperframes 链路行为不变（默认 mode 不变）

---

### Task 1: CLI 适配层 `server/src/jimeng/cli.ts` + 错误分类

**Files:** Create `server/src/jimeng/cli.ts`, `server/src/jimeng/errors.ts`; Test `server/test/jimeng.cli.test.ts`

**Interfaces:**
- `type CliRunner = (args: string[], env: Record<string,string>, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>`
- `interface JimengError { code: string; class: string; message: string; retryable: boolean; requiredAction: string; creditConfirmation?: { reason: string; minimumCreditCeiling?: number }; partialData?: { items?: Array<{ nodeId?: string; submitId?: string; resourceId?: string }> } }`
- `class JimengCli { constructor(opts?: { bin?: string; homeDir?: string; stateDir?: string; runner?: CliRunner }); call<T>(args: string[], opts?: { timeoutMs?: number }): Promise<{ code: number; ok: boolean; data?: T; error?: JimengError; requestId?: string }> }`
- 默认 runner：`Bun.spawn` 执行 bin + env；默认路径 `resolve(import.meta.dir, "../../../.tools/dreamina-canvas/bin/dreamina-canvas")`（可 `HF_JIMENG_BIN` 覆盖）
- `errors.ts`：`isConfirmationRequired(e)`（`requiredAction==="confirm"` 或 code `cli.generation_confirmation_required`）、`isAuthRequired(e)`（`requiredAction==="login"` 或 code 前缀 `cli.auth`）、`isWaitTimeout(code)`（20）、`isRetryable(e)`（retryable=true 或 code 20/21）

**Steps:**
- [x] 写测试：JSON envelope 解析（ok/data/error/meta.requestId）；非 JSON 输出兜底（raw 包装）；退出码 10/11/20 分类；args 透传
- [x] 实现 `cli.ts`（解析 `{schemaVersion, ok, data, error, meta}`）、`errors.ts`
- [x] `bun test test/jimeng.cli.test.ts` 全绿

### Task 2: 服务状态机 `server/src/jimeng/service.ts`

**Files:** Create `server/src/jimeng/service.ts`; Test `server/test/jimeng.service.test.ts`

**Interfaces:**
- `interface JimengVideoRequest { prompt: string; model: string; ratio: string; resolution: string; durationSec: number; count?: number; title?: string; creditCap?: number }`
- `interface JimengState { projectId?: string; webUrl?: string; nodeId?: string; submitId?: string; resourceId?: string; clipPath?: string; status: "new"|"quoted"|"submitted"|"succeeded"|"failed"|"needs_confirmation"; quote?: { totalMaxCredits: number; confirmationRequired: boolean } }`
- `class JimengService { constructor(cli: JimengCli, opts: { projectDir: string; statePath?: string; log?: (m: string) => void }); async ensureVideo(req): Promise<{ state: JimengState; clipAbsPath: string }> }`
- 异常：`JimengConfirmationRequiredError`（带 quote）、`JimengAuthRequiredError`、`JimengWaitTimeoutError`（state 已保存）
- 状态文件：`<projectDir>/jimeng/state.json`；片段：`<projectDir>/jimeng/main.mp4`

**Steps:**
- [x] 写测试（fake runner 按调用序列返回）：
  - 新任务：canvas create → node create → quote(45, confirmationRequired=false) → run(submitId) → wait(succeeded, resourceId) → download → 文件存在、state.succeeded
  - 续跑：state.submitId 已存在 → 不调 run，直接 wait；download 后成功
  - confirmationRequired=true 且无 cap → 抛确认异常、state=needs_confirmation、不调 run
  - confirmationRequired=true 且有 cap≥报价 → 调 `node confirm --credit-ceiling` → `node run --credit-token`
  - wait 超时（code 20）→ 抛 `JimengWaitTimeoutError`，state 保留 submitId
- [x] 实现 service
- [x] `bun test test/jimeng.service.test.ts` 全绿

### Task 3: 引擎接线 + step0-3 跳过

**Files:** Modify `server/src/types.ts`（`JobMode`、`JobConfig.mode/jimeng`、`StepContext.jimeng?`）、`server/src/pipeline/engine.ts`（Services.jimeng 工厂 + ctx 注入）、`server/src/index.ts`（真实工厂）；Modify steps `step0-parse/1-design/2-storyboard/3-tts`（jimeng 模式直接 passed）；Test `server/test/jimeng.steps.test.ts`

**Steps:**
- [x] 写测试：jimeng 模式下 step0-3 返回 passed 且不调用 LLM/TTS（用缺省 stub 验证）
- [x] 实现 guards（`if (ctx.config.mode === "jimeng") return { status:"passed", artifacts:[], data:{ skipped:true }, log:"AI 直出模式跳过（Phase 1）" }`）
- [x] engine：`Services.jimeng?: (projectDir, config) => JimengService`；`StepContext.jimeng?: JimengService`；index.ts 构造
- [x] 现有 engine/store/api 测试保持全绿（`bun test --timeout 60000`）

### Task 4: step4/5/6 jimeng 分支

**Files:** Create `server/src/pipeline/steps/jimeng-video.ts`（构建请求/默认参数/clamp）；Modify `step4-build.ts`、`step5-validate.ts`、`step6-render.ts`；Test `server/test/jimeng.steps.test.ts`

**默认参数：** model `seedance_2.5_draft`（可被 `config.jimeng.model` 覆盖）；resolution 480p（draft 仅支持）；ratio：landscape→16:9 / portrait→9:16 / square→1:1；duration：`clamp(round(config.durationSec), 4, 15)`；creditCap 透传
**分支行为：**
- step4：`ctx.jimeng.ensureVideo(...)` → artifacts `jimeng/state.json`、`jimeng/main.mp4`；捕获确认异常 → `status:"failed"`（log 含报价与所需 ceiling）
- step5：ffprobe 片段（存在、有视频流、时长偏差 ≤30%）
- step6：复制 `jimeng/main.mp4` → `renders/output.mp4` + probe 门（时长/视频流）
- [x] 测试：step4 成功/确认异常；step5 正常与坏文件；step6 产出与 probe；用 ffmpeg 生成 1s 测试视频
- [x] `bun test --timeout 60000` 全绿

### Task 5: API + 前端向导

**Files:** Modify `server/src/api/server.ts`（解析 `mode`，jimeng 模式 model 可空）、`web/src/pages/NewJob.tsx`（制作方式选择 + 各步适配 + 提交 `mode`）、`web/src/types.ts`
**Steps:**
- [x] API：`mode` 校验（默认 hyperframes）；jimeng 时不要求 model；`jimengCreditCap` 可选数字
- [x] 向导：步骤 0 顶部「制作方式」分段；AI 直出时隐藏 主题/清晰度/生成速度/配音/字幕，显示说明；模型步可跳过（无需渠道）；汇总显示制作方式
- [x] `cd web && bun run build` 通过
- [x] `cd server && bun test --timeout 60000 && ./node_modules/.bin/tsc --noEmit` 全绿

### Task 6: 验收

- [x] 真实 E2E：`job-mum4ew66-tz89u2` completed；45 积分；`renders/output.mp4` h264 854×480 5.02s + aac（2026-09-29）
- [x] 汇报：改动文件清单、测试结果、真实产物路径与验收数据

## Self-Review

- spec 覆盖：Phase 1 范围（单条直出）✔；零宿主 ✔；积分纪律 ✔；幂等 ✔
- 不涉及：分镜、旁白/字幕、报价确认 UI、混合模式（Phase 2+）
- 风险：即梦真实网络/排队波动 → 超时按可恢复处理；CLI 输出以实测为准
