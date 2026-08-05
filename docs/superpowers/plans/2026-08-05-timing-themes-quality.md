# 音画对齐 + 主题模板 + 时长软目标 + 质量提升 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development. Steps use `- [ ]`.

**Goal:** 修复音画不同步（视频提前结束）、默认横屏并明示分辨率、加入主题预设+色相微调、时长软目标 15/30/60/90+自定义、全面提升生成质量。

**Architecture:** 边界等计时全部改用 ffprobe 真实音频时长 + 结尾停留凑软目标；主题/色相/清晰度作为 JobConfig 扩展经 API 进引擎，注入 design/storyboard 与渲染档位；质量靠提示词红线 + 生成档位 medium。

**Tech Stack:** bun+TS（服务端 TDD：bun:test）；React 19+Vite（前端 build 验证）；hyperframes CLI（验收渲染）。

## Global Constraints

- 执行子代理模型 **deepseek-v4-flash**；不改宿主机；不新增依赖；提交原子、只含相关文件
- 服务端验证：`cd hf-studio/server && bun test --timeout 60000 && tsc --noEmit` 全绿
- 前端验证：`cd hf-studio/web && bun run build` 通过
- spec：`docs/superpowers/specs/2026-08-05-timing-themes-quality-design.md`

---

### Task 1: 真实时长边界 + 软目标收尾（服务端，TDD）

**Files:**
- Modify: `hf-studio/server/src/pipeline/steps/step3-tts.ts`（真实 ffprobe 边界 + 门改真实值）
- Modify: `hf-studio/server/src/pipeline/beat-timing.ts`（新增 `buildRealBoundaries`：入参 realSecs、gap；返回 boundaries；导出）
- Modify: `hf-studio/server/src/pipeline/steps/step4-build.ts`（软目标末尾停留：最后一个 beat endSec 补齐）
- Modify: `hf-studio/server/src/pipeline/root-html.ts`（总时长/audio data-duration 用 max(boundaryEnd, target)；若已在 step3 计算则传入）
- Create/Modify: `hf-studio/server/test/beat-timing.test.ts`、`hf-studio/server/test/step3-tts.test.ts`、`hf-studio/server/test/step4-build.test.ts`

**Interfaces:**
- Consumes: `probeMedia`(src/util/ffprobe.ts)；`estimateSec`(beat-timing.ts 保留)
- Produces: `buildRealBoundaries(realSecs: number[], gapSec: number): Boundary[]`；step3 data 增 `realTotalSec`；step4 data 增 `finalEndSec`

**关键实现（逐字）：**
```ts
// beat-timing.ts 新增
export function buildRealBoundaries(realSecs: number[], gapSec: number): Boundary[] {
  const boundaries: Boundary[] = [];
  let cursor = 0;
  realSecs.forEach((sec, i) => {
    boundaries.push({ index: i + 1, startSec: cursor, endSec: cursor + sec });
    cursor += sec + (i < realSecs.length - 1 ? gapSec : 0);
  });
  return boundaries;
}
```
- step3：每 beat `probeMedia(wav)` 得真实秒数（不再用 synthesizeToWav 的 durationSec 定边界；TTS 门仍可用其返回）；`buildRealBoundaries(realSecs, 0.25)`；门：`|totalReal - estimateTotal|/estimateTotal > 0.3 → gate_failed`；data 增 `{ realTotalSec, boundaries }`。
- step4：`totalReal = boundaries.at(-1)?.endSec ?? 0; target = ctx.config.durationSec; tailHold = Math.max(0.6, Math.min(target - totalReal, target * 0.5)); if (tailHold > 0) 最后一个 timedBeat.endSec = totalReal + tailHold;` 并据此生成 index.html（root-html 接收 finalEndSec 覆盖总时长与 audio data-duration）。
- 测试：
  1. `buildRealBoundaries([3,5,2], 0.25)` → ends [3, 8.25, 10.25]；单元素无尾间隙。
  2. step3：mock probeMedia 返回真实值 → boundaries 用真实值；偏差门用 realTotal。
  3. step4：config.durationSec=60、totalReal=40 → 末尾 beat endSec=60；totalReal=70 → 末尾保持 70.6；durationSec=15、totalReal=14 → endSec=15。

### Task 2: 主题 + 色相 + 质量档位（服务端 + 提示词，TDD）

**Files:**
- Modify: `hf-studio/server/src/types.ts`（JobConfig 增 `theme?: { id: string; hue?: { primary?: string; accent?: string } }; renderQuality?: "standard" | "high"`）
- Modify: `hf-studio/server/src/api/server.ts`（解析 `theme` JSON 与 `renderQuality`）
- Modify: `hf-studio/server/src/pipeline/steps/step1-design.ts` 与 `step2-storyboard.ts`（user content 注入《主题约束》：主题关键词 + hue 值 + "主色/强调色必须采用给定值"）；step1 未选中主题时行为不变
- Modify: `hf-studio/server/src/pipeline/engine.ts`（step6 渲染 quality 用 `config.renderQuality`）
- Modify: `hf-studio/server/src/pipeline/steps/step6-render.ts`（透传 quality）
- Modify: `hf-studio/server/src/pipeline/steps/step4-build.ts` 与 `step5-validate.ts`：`reasoningEffort: "low"` → `"medium"`（两处注释同步改）
- Modify: `hf-studio/server/src/prompts/design.txt`（追加《质量红线》段）
- Modify: `hf-studio/server/src/prompts/build-beat.txt`（追加《反平庸与细节质量》段）
- Modify: `hf-studio/server/test/api.test.ts`（theme/renderQuality 解析用例）

**接口：** JobConfig.theme 透传到 step1/step2 的 userContent JSON；renderQuality 到 step6。

**主题关键词表（注入用，逐字）**：tech=深蓝紫霓虹/网格/数据感/高对比；nature=米白绿/柔和圆角/大留白/自然光；business=白深灰蓝/大字号/克制动效/专业权威；warm=奶油橙棕/圆润/亲和/教育；retro=暖黄锈红/颗粒/衬线大字/年代感；dark=近黑底/荧光强调/霓虹边框/大标题。

**质量红线（design.txt 末尾追加，逐字）**：
```
## 质量红线（违反即差评）
- 禁止"浅色纯底 + 居中标题"的默认模板感；每个画面必须有明确的视觉焦点与信息层级。
- 排版必须分层：标题/副题/正文的字号、字重、行高差异明显（标题 ≥80px 且 ≥ 副题 1.5 倍）。
- 颜色：给出 8-12 个带语义角色的 HEX；主色与强调色对比度 ≥ 4.5:1；说明亮/暗两种用法。
- 组件规范必须可直接执行（给出具体数值：圆角、内边距、阴影、边框），禁止"美观即可"这类空话。
```
**反平庸（build-beat.txt 末尾追加，逐字）**：
```
## 反平庸与细节质量（违反即差评）
- 禁止"一张色卡 + 一行居中文字"的占位感；每 beat 必须有视觉焦点与主次分明的情报层级。
- 动效至少两个层次且要有"运动感"（位移/缩放/遮罩/路径/条带/粒子任选其一），禁止仅淡入淡出；
  出场 0.4-0.8s，入场与内容动效错峰（不全部同时开始）。
- 装饰元素（网格线/光斑/图形/图标）要与 DESIGN.md 语义一致，颜色来自色板，禁止随手用与 CSS 冲突的渐变。
- 文字可读性优先：正文 ≥32px、行高 ≥1.4、对比度足够；标题允许装饰但必须可读。
```

### Task 3: 前端（主题卡片 + 色相 + 时长 + 画幅 + 清晰度，build 验证）

**Files:**
- Modify: `hf-studio/web/src/pages/NewJob.tsx`（Step1：主题卡片网格（6 预置 + 自由发挥）+ 色相 `<input type="color">`；时长分段 [15/30/60/90] + 自定义 number(5-240)；画幅默认 landscape，标签带分辨率字数；清晰度 segmented（标准/高清）；第 3 步汇总补主题/色相/清晰度；提交 form.set("theme", JSON.stringify(...))、form.set("renderQuality", ...)）
- Modify: `hf-studio/web/src/pages/JobDetail.tsx`（显示格式・分辨率・清晰度・主题）
- Modify: `hf-studio/web/src/types.ts` 与 `api.ts`（如需）
- 验证：`cd hf-studio/web && bun run build`

### Task 4（控制器执行）: 真实 E2E 验收

- `data/` 下新建任务：idea=太阳能科普 60s、landscape、theme=tech+hue、renderQuality=standard、voiceover=on
- ffprobe 断言：w=1920 h=1080；视频时长 ≥ narration.wav 时长（音画对齐）；时长 ∈ [45,75]s（±25% 软目标）；产物 index.html 用主题色
- 记录证据并汇报