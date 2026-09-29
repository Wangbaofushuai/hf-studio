# 即梦直出 Phase 2（分镜级）Implementation Plan

> **For agentic workers:** 按任务顺序执行，TDD；提交由用户决定（AI 不自动提交）。

**Goal:** jimeng 模式升级为分镜级：复用 brief/design/storyboard/TTS，逐 beat 生成即梦片段 → 时长对齐拼接 + 旁白混音 + 字幕 → `renders/output.mp4`；含报价确认与断点续跑。

**Architecture:** 服务层增加多 item 状态机（`state.items[key]`，key=beat-N）；step0-3 在 jimeng 模式恢复实际执行（step2 加 beat 时长约束）；step4 逐 beat 生成（t2v；有素材 m2v）；step5 逐片段 probe；step6 ffmpeg 归一化拼接 + 混音 + 字幕（复用 ass/burn）；新增 credit-approve API 与登录状态 API。

**Tech Stack:** TS + bun + 即梦画布 CLI + ffmpeg/ffprobe + bun:test

## Global Constraints

- spec：`docs/superpowers/specs/2026-09-29-jimeng-canvas-direct-video-design.md`；Phase 1 plan 已完成记录在 `2026-09-29-jimeng-phase1.md`
- 幂等：每 beat 保存 `nodeId/submitId/resourceId/clipPath`；重跑跳过已成功项；超时只续查
- 积分：`creditCap` 为**单 node 上限**；服务端要求确认且 cap 不足 → 暂停并返回 `data.jimengConfirmation`，前端确认卡片 → `POST /api/jobs/:id/credit-approve` → 写回 cap 并 `rerunFrom(4)`
- 兼容：Phase 1 单条任务（state 顶层有 submitId/clipPath、无 items）保持原逻辑（`ensureVideo`）
- 配音：有旁白 → 片段原声压至 0.2 做底 + narration 混入；无旁白 → 保留原声；字幕仅在旁白开启时烧录
- 音频/视频归一化后才能 concat（统一 30fps / yuv420p / aac 48k 双声道；短片段用 tpad/apad 补齐到 beat 窗口）

---

### Task 1: 服务层多 item 状态机（service.ts）

**Interfaces:**
- `interface JimengItemState { key; status; nodeId?; submitId?; resourceId?; clipPath?; quote?; error? }`
- `JimengJobState.items?: Record<string, JimengItemState>`（新增；顶层单条字段保留兼容）
- `ensureItem(key, req): Promise<{ item; clipAbsPath }>`（与 ensureVideo 同流；state.items[key] 持久化）
- `isLegacySingleState(state)`（有顶层 submitId/clipPath 且无 items）
- `ensureVideo` 保持不变
- 文件：`server/src/jimeng/service.ts`；测试 `server/test/jimeng.service.test.ts` 扩展

**Steps:**
- [x] 测试：两个 beat 顺序生成各自 state；重跑跳过已成项；报价确认挂起（needs_confirmation）保留 nodeId/quote；单项失败不影响其他项
- [x] 实现 + 全绿

### Task 2: step0-3 恢复执行（jimeng 模式）

**Files:** `server/src/pipeline/steps/mode.ts`（删除跳过逻辑）、`step2-storyboard.ts`（jimeng 追加约束）、`server/test/jimeng.steps.test.ts`（改写）
**Steps:**
- [x] step0-2：jimeng 模式正常执行（LLM 链路）；step2 校验门追加：每 beat 估算时长 ≤ `clipMaxSec`（默认 15s）→ 不合格 gate_failed 反馈重生成
- [x] step3：正常 TTS（voiceover 开关沿用）
- [x] 测试更新：删除「跳过」断言；新增 step2 约束用例（mock LLM 输出超长 beat → gate_failed）
- [x] `bun test --timeout 60000` 全绿

### Task 3: step4 分镜生成

**Files:** `server/src/pipeline/steps/step4-build.ts`（jimeng 分支重写）、`server/src/pipeline/steps/jimeng-video.ts`（prompt 组装/素材引用）
**Steps:**
- [x] prompt：beat.narration + mood/techniques + DESIGN.md 风格摘要（截断），≤4000 字（seedance 2.5 上限 15000）
- [x] 素材：beat.assets 有图 → `resource upload` + `node create image --resource-id --import-kind local_upload` 得 nodeId → 视频 `--mode m2v --ref node:<id>`；无素材 → t2v
- [x] 逐 beat `ensureItem`；每项后更新 data.jimeng.items 汇总；全部成功 → passed（artifacts: state.json + 全部 clip）
- [x] 确认挂起：`JimengConfirmationRequiredError` → `status:"failed"` + `data.jimengConfirmation = { key, minimumCreditCeiling, quote }`
- [x] 测试：fake service 两 beat 成功；m2v 分支参数断言；确认挂起 data 结构

### Task 4: step5/step6 分镜校验与成片

**Files:** `step5-validate.ts`、`step6-render.ts`、`server/src/util/ffprobe.ts`（追加 width/height）、`server/src/util/assemble.ts`（新：归一化/拼接/混音纯命令 + 执行）
**Steps:**
- [x] step5：逐片段 probe（存在/视频流/时长 ≥ beat 窗口*0.7），全通过 → passed（artifacts: clips + state.json）
- [x] step6：归一化每个 clip（scale/pad 到首片段尺寸、30fps、音轨 volume 0.2+apad 或原声+apad、trim/tpad 到 beat 窗口）→ concat demuxer copy → 有旁白则 amix narration.wav → 字幕烧录（复用 ass/burn，失败不阻塞）→ probe 门 → `renders/output.mp4`
- [x] 单测：用 ffmpeg 生成 2 个 1s 测试片段 + 1s narration → assemble 产出 mp4，时长=窗口和，含音轨；无旁白分支保留原声
- [x] `bun test --timeout 60000` 全绿

### Task 5: 报价确认 + 登录 API/UI

**Files:** `server/src/api/server.ts`（credit-approve、jimeng status/login）、`web/src/pages/JobDetail.tsx`（确认卡片）、`web/src/pages/Channels.tsx`（即梦账号卡片）、`web/src/api.ts`/`types.ts`
**Steps:**
- [x] `POST /api/jobs/:id/credit-approve { ceiling }`：写 config.jimeng.creditCap=max(现有,ceiling) → rerunFrom(4)
- [x] `GET /api/jimeng/status`（version/auth status/account）、`POST /api/jimeng/login`（`auth login --non-interactive` 返回 challenge 并后台 `auth wait`）、`POST /api/jimeng/logout`
- [x] JobDetail：steps[4].data.jimengConfirmation 存在 → 展示报价 + 「批准并继续」按钮
- [x] Channels：即梦账号卡片（状态/开始登录/链接+验证码/轮询/退出）
- [x] `bun run build` 通过

### Task 6: 向导适配 + 真实 E2E

**Files:** `web/src/pages/NewJob.tsx`
**Steps:**
- [x] jimeng 模式恢复显示 配音/字幕/旁白语言/音色（旁白可选）；模型步恢复必选（LLM 用于 0-2 步），文案注明用途；隐藏主题/清晰度/生成速度；素材上传可用（m2v）
- [x] 真实 E2E：`job-mum7qtg0-1mekb5` completed（4 段/16.5s/4×45+36=171 积分）；output.mp4 854×480 16.5s + aac + 中文字幕（2026-09-29）
- [x] 汇报

## Self-Review
- spec 覆盖：分镜生成/时长对齐/拼接/混音/字幕/报价确认/登录卡片/续跑 ✔（混合模式留 Phase 3）
- 风险：片段时长不足（tpad 补齐兜底）；多 beat 报价触发确认（UI 卡片）；即梦排队（wait 超时续查）
