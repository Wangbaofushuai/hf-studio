# 硬字幕烧录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 渲染后用 ffmpeg ASS 烧录旁白字幕进 `renders/output.mp4`，样式跟随 DESIGN 主题，默认开启。

**Architecture:** 纯函数 ASS 生成器（`subtitle/ass.ts`）+ ffmpeg 烧录函数（`subtitle/burn.ts`），在 step6 渲染成功后烧录、失败保留无字幕原片。与 LLM/HTML 完全解耦。

**Tech Stack:** TypeScript + bun + ffmpeg（libass/fontconfig 已验证）、bun:test

## Global Constraints

- 遵循 spec：`docs/superpowers/specs/2026-08-12-subtitles-design.md`
- 烧录失败**不判任务失败**：保留无字幕 output.mp4，log 警告后通过
- 无配音模式（`voiceover=false`）跳过烧录
- 字体：`Noto Sans CJK SC`（服务器已装）；取色优先级：`config.theme.hue.primary` → DESIGN.md 首个 HEX → `#ffffff`
- 样式：BorderStyle 3 半透明黑底（`&H66000000`），Outline/Shadow 0，文字色=主题主色；字号=屏高 6%，MarginV=屏高 5%
- 提交：小步原子，`feat:` / `test:` / `docs:` 前缀

---

### Task 1: 纯函数 ASS 生成器 `server/src/subtitle/ass.ts`

**Files:**
- Create: `server/src/subtitle/ass.ts`
- Test: `server/test/subtitle.ass.test.ts`

**Interfaces:**
- Produces:
  - `interface SubtitleLine { startSec: number; endSec: number; text: string }`
  - `interface SubtitleStyle { primaryColor: string; fontName: string; fontSizePx: number; marginVPx: number; width: number; height: number }`
  - `formatAssTime(sec: number): string` — ASS 时间格式 `H:MM:SS.cc`（截断到厘秒，保证相邻字幕单调不重叠，负数钳 0）
  - `assColor(hex: string): string` — `#RRGGBB` → `&H00BBGGRR`（非法输入返回 `&H00FFFFFF`）
  - `buildAss(lines: SubtitleLine[], style: SubtitleStyle): string`
  - `extractPrimaryColor(designMd: string): string | null` — DESIGN.md 中首个 `#rrggbb`
  - `pickPrimaryColor(themePrimary: string | undefined, designMd: string): string`

- [ ] **Step 1: 写失败测试**

`server/test/subtitle.ass.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatAssTime, assColor, buildAss, extractPrimaryColor, pickPrimaryColor } from "../src/subtitle/ass";

describe("ass subtitle builder", () => {
  test("formatAssTime formats H:MM:SS.cc", () => {
    expect(formatAssTime(0)).toBe("0:00:00.00");
    expect(formatAssTime(61.527)).toBe("0:01:01.52");
    expect(formatAssTime(600)).toBe("0:10:00.00"); // 600 秒 = 10 分钟
    expect(formatAssTime(-1)).toBe("0:00:00.00");
  });

  test("assColor converts hex to ASS BGR", () => {
    expect(assColor("#0071e3")).toBe("&H00E37100");
    expect(assColor("#ffffff")).toBe("&H00FFFFFF");
    expect(assColor("not-a-color")).toBe("&H00FFFFFF");
  });

  test("buildAss emits valid sections and dialogues", () => {
    const ass = buildAss(
      [
        { startSec: 0, endSec: 1.5, text: "你好，世界" },
        { startSec: 1.5, endSec: 3, text: "第二段{a}测试" },
      ],
      { primaryColor: "#0071e3", fontName: "Noto Sans CJK SC", fontSizePx: 65, marginVPx: 54, width: 1920, height: 1080 },
    );
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("ScriptType: v4.00+");
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("Style: Default,Noto Sans CJK SC,65,&H00E37100,&H00FFFFFF,&H00101010,&H66000000,0,0,0,0,100,100,0,0,3,0,0,2,60,60,54,1");
    expect(ass).toContain("[Events]");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,你好，世界");
    expect(ass).toContain("Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,第二段｛a｝测试"); // {} 转全角防 override 解析
  });

  test("extractPrimaryColor finds first hex in DESIGN.md", () => {
    expect(extractPrimaryColor("## Quick Reference\n- 主色 #ff0000\n- 强调 #00ff00")).toBe("#ff0000");
    expect(extractPrimaryColor("no colors here")).toBeNull();
  });

  test("pickPrimaryColor prioritizes theme hue, then design, then fallback", () => {
    expect(pickPrimaryColor("#123456", "no colors")).toBe("#123456");
    expect(pickPrimaryColor("garbage", "主题色 #ff8800")).toBe("#ff8800");
    expect(pickPrimaryColor(undefined, "no colors")).toBe("#ffffff");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && bun test test/subtitle.ass.test.ts --timeout 60000`
Expected: FAIL（模块不存在，`Cannot find module`）

- [ ] **Step 3: 实现**

`server/src/subtitle/ass.ts`:

```ts
export interface SubtitleLine { startSec: number; endSec: number; text: string }
export interface SubtitleStyle {
  primaryColor: string;
  fontName: string;
  fontSizePx: number;
  marginVPx: number;
  width: number;
  height: number;
}

/** ASS 时间格式 H:MM:SS.cc（厘秒，四舍五入；负数钳 0） */
export function formatAssTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const cc = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cc).padStart(2, "0")}`;
}

/** #RRGGBB → ASS &H00BBGGRR（alpha 固定 00 = 不透明）；非法输入兜底白色 */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "&H00FFFFFF";
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `&H00${b.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${r.toString(16).padStart(2, "0")}`;
}

export function buildAss(lines: SubtitleLine[], style: SubtitleStyle): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${style.width}
PlayResY: ${style.height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontName},${style.fontSizePx},${assColor(style.primaryColor)},&H00FFFFFF,&H00101010,&H66000000,0,0,0,0,100,100,0,0,3,0,0,2,60,60,${style.marginVPx},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = lines.map((l) => {
    // {} 是 ASS override 标记，转全角防字幕文本被误解析
    const text = l.text.replace(/\r?\n/g, " ").replace(/{/g, "｛").replace(/}/g, "｝");
    return `Dialogue: 0,${formatAssTime(l.startSec)},${formatAssTime(l.endSec)},Default,,0,0,0,,${text}`;
  });
  return header + events.join("\n") + "\n";
}

const HEX_RE = /#[0-9a-fA-F]{6}/g;

/** DESIGN.md 中首个 HEX 颜色（小写）；无则 null */
export function extractPrimaryColor(designMd: string): string | null {
  if (!designMd) return null;
  const hexes = designMd.match(HEX_RE) ?? [];
  return hexes.length > 0 ? hexes[0].toLowerCase() : null;
}

export function pickPrimaryColor(themePrimary: string | undefined, designMd: string): string {
  if (themePrimary && /^#?[0-9a-fA-F]{6}$/.test(themePrimary.trim())) return themePrimary.trim();
  return extractPrimaryColor(designMd) ?? "#ffffff";
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd server && bun test test/subtitle.ass.test.ts --timeout 60000`
Expected: PASS（5 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add server/src/subtitle/ass.ts server/test/subtitle.ass.test.ts
git commit -m "feat: add ASS subtitle builder (pure functions)"
```

---

### Task 2: ffmpeg 烧录函数 `server/src/subtitle/burn.ts`

**Files:**
- Create: `server/src/subtitle/burn.ts`
- Test: `server/test/subtitle.burn.test.ts`

**Interfaces:**
- Consumes: `buildAss` from Task 1（测试里用）
- Produces: `burnSubtitles(input: string, assPath: string, output: string): Promise<void>` — 失败抛错、成功后原子替换 output

- [ ] **Step 1: 写失败测试**

`server/test/subtitle.burn.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { burnSubtitles } from "../src/subtitle/burn";
import { buildAss } from "../src/subtitle/ass";
import { probeMedia } from "../src/util/ffprobe";

describe("burnSubtitles", () => {
  test("burns ass onto a tiny video keeping duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-burn-"));
    const input = join(dir, "in.mp4");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2", "-pix_fmt", "yuv420p", input], { stdio: "pipe" });
    const assPath = join(dir, "subs.ass");
    writeFileSync(assPath, buildAss([{ startSec: 0, endSec: 2, text: "测试字幕" }], { primaryColor: "#ffffff", fontName: "Noto Sans CJK SC", fontSizePx: 20, marginVPx: 12, width: 320, height: 240 }));
    const out = join(dir, "out.mp4");
    await burnSubtitles(input, assPath, out);
    expect(existsSync(out)).toBe(true);
    const probe = await probeMedia(out);
    expect(probe.hasVideo).toBe(true);
    expect(probe.durationSec).toBeGreaterThan(1.5);
    expect(probe.durationSec).toBeLessThan(3);
    rmSync(dir, { recursive: true, force: true });
  }, 120000);

  test("throws on missing ass and leaves no temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-burn2-"));
    const input = join(dir, "in.mp4");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1", "-pix_fmt", "yuv420p", input], { stdio: "pipe" });
    await expect(burnSubtitles(input, join(dir, "nope.ass"), join(dir, "out.mp4"))).rejects.toThrow();
    expect(existsSync(join(dir, "out.mp4.subtmp.mp4"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 120000);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && bun test test/subtitle.burn.test.ts --timeout 60000`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`server/src/subtitle/burn.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { renameSync, rmSync } from "node:fs";

const execFileP = promisify(execFile);

/** 用 libass 把 ASS 字幕烧录进视频（二次编码 libx264 crf18，音频 copy）。
 *  先写临时文件再原子替换 output；失败清理临时文件并抛错（调用方决定是否保留原视频）。 */
export async function burnSubtitles(input: string, assPath: string, output: string): Promise<void> {
  const tmp = `${output}.subtmp.mp4`;
  try {
    await execFileP(
      "ffmpeg",
      ["-y", "-i", input, "-vf", `ass=${assPath}`, "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "copy", tmp],
      { timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
    );
    renameSync(tmp, output);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd server && bun test test/subtitle.burn.test.ts --timeout 60000`
Expected: PASS（2 个测试全绿，含真实 ffmpeg 烧录）

- [ ] **Step 5: 提交**

```bash
git add server/src/subtitle/burn.ts server/test/subtitle.burn.test.ts
git commit -m "feat: add ffmpeg ASS burn function"
```

---

### Task 3: 服务端接线（types + API + step6 烧录）

**Files:**
- Modify: `server/src/types.ts`（JobConfig 增 `subtitles?: boolean`）
- Modify: `server/src/api/server.ts:48-114`（解析 subtitles 表单字段）
- Modify: `server/src/pipeline/steps/step6-render.ts`（渲染后烧录 + probe 门）
- Test: `server/test/step6-render.test.ts`（新增字幕用例）

**Interfaces:**
- Consumes: `buildAss`/`pickPrimaryColor`（Task 1）、`burnSubtitles`（Task 2）、`RESOLUTIONS`（`server/src/render/resolutions.ts`）
- Produces: step6 产物追加 `renders/subs.ass`（烧录成功时）；`config.subtitles === false` 或 `voiceover=false` 跳过

- [ ] **Step 1: 写失败测试（types + step6 字幕用例）**

`server/src/types.ts` 在 `JobConfig` 中（`renderQuality` 之后）加：

```ts
  subtitles?: boolean;                             // 旁白字幕烧录（默认开启；voiceover=false 时跳过）
```

`server/test/step6-render.test.ts` 追加：

```ts
import type { StepOutput } from "../src/types";
import { readFileSync, existsSync } from "node:fs";

test("burns subtitles when enabled and beats present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-step6-sub-"));
  const render = {
    render: async (out: string) => {
      const { execFileSync } = await import("node:child_process");
      execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2", "-pix_fmt", "yuv420p", out], { stdio: "pipe" });
    },
  };
  const prev = Array.from({ length: 5 }, () => ({ data: {} })) as unknown as StepOutput[];
  (prev as unknown as { data: Record<string, unknown> }[])[1].data = { design: "## Quick Reference\n主色 #ff0000" };
  (prev as unknown as { data: Record<string, unknown> }[])[2].data = {
    storyboard: { beats: [{ index: 1, narration: "你好世界" }, { index: 2, narration: "第二段" }] },
  };
  (prev as unknown as { data: Record<string, unknown> }[])[4].data = {
    beats: [{ index: 1, startSec: 0, endSec: 1 }, { index: 2, startSec: 1, endSec: 2 }],
  };
  const ctx = { jobId: "j1", projectDir: dir, config: { ...cfg, durationSec: 2, theme: { id: "tech", hue: { primary: "#123456" } } }, render, feedback: null, log: () => {} } as unknown as StepContext;
  const r = await step6Render(ctx, prev);
  expect(r.status).toBe("passed");
  expect(r.artifacts).toContain("renders/output.mp4");
  expect(r.artifacts).toContain("renders/subs.ass");
  expect(existsSync(join(dir, "renders", "subs.ass"))).toBe(true);
  const ass = readFileSync(join(dir, "renders", "subs.ass"), "utf8");
  expect(ass).toContain("&H00563412"); // theme 主色 #123456 → ASS BGR
  expect(ass).toContain("你好世界");
}, 120000);

test("burn failure keeps original video and still passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-step6-noburn-"));
  const render = {
    render: async (out: string) => {
      const { execFileSync } = await import("node:child_process");
      execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2", "-pix_fmt", "yuv420p", out], { stdio: "pipe" });
    },
  };
  const prev = Array.from({ length: 5 }, () => ({ data: {} })) as unknown as StepOutput[];
  (prev as unknown as { data: Record<string, unknown> }[])[2].data = { storyboard: { beats: [{ index: 1, narration: "你好" }] } };
  (prev as unknown as { data: Record<string, unknown> }[])[4].data = { beats: [{ index: 1, startSec: 0, endSec: 2 }] };
  const ctx = {
    jobId: "j1", projectDir: dir, config: { ...cfg, durationSec: 2 },
    render, feedback: null, log: () => {},
    _burnSubtitles: async () => { throw new Error("burn boom"); }, // 注入失败烧录（沿 _probeMedia 注入模式）
  } as unknown as StepContext;
  const r = await step6Render(ctx, prev);
  expect(r.status).toBe("passed");
  expect(r.artifacts).toEqual(["renders/output.mp4"]); // 不包含 subs.ass
  expect(existsSync(join(dir, "renders", "output.mp4"))).toBe(true);
}, 120000);
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && bun test test/step6-render.test.ts --timeout 60000`
Expected: FAIL（`config.subtitles` 类型不存在 / step6 未烧录 → `subs.ass` 不存在）

- [ ] **Step 3: 实现**

`server/src/api/server.ts`（`renderQuality` 解析之后、`if (!idea.trim())` 之前）加：

```ts
    // 字幕烧录：默认开启；显式 "false" 关闭
    const subtitles = String(form.get("subtitles") ?? "true") !== "false";
```

`server/src/api/server.ts` 第 88-95 行 `createJob` 配置对象加 `subtitles,`；第 111 行 `updateJob` 配置对象加 `subtitles,`。

`server/src/pipeline/steps/step6-render.ts` 整体改为：

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult } from "../../types";
import { probeMedia } from "../../util/ffprobe";
import { RESOLUTIONS } from "../../render/resolutions";
import { buildAss, pickPrimaryColor, type SubtitleLine, type SubtitleStyle } from "../../subtitle/ass";
import { burnSubtitles } from "../../subtitle/burn";

export const step6Render: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const outPath = "renders/output.mp4";
  const abs = join(ctx.projectDir, outPath);
  const quality = (ctx as unknown as { _renderQuality?: string })._renderQuality ?? ctx.config.renderQuality ?? "standard";
  mkdirSync(join(ctx.projectDir, "renders"), { recursive: true });
  try {
    await ctx.render.render(abs, quality as "standard" | "high");
  } catch (e) {
    return { status: "gate_failed", artifacts: [], data: {}, log: `渲染失败`, gateErrors: [e instanceof Error ? e.message : String(e)] };
  }
  if (!existsSync(abs)) {
    return { status: "gate_failed", artifacts: [], data: {}, log: "渲染产物缺失", gateErrors: ["render 未产出文件"] };
  }

  // 字幕烧录：默认开启；配音关闭或缺少 beat 数据时跳过。烧录失败不判任务失败（保留无字幕原片）。
  const doSubtitles = ctx.config.subtitles !== false && ctx.config.voiceover;
  let subsArtifact: string | null = null;
  if (doSubtitles) {
    const storyBeats = (prev[2]?.data.storyboard as { beats: { index: number; narration: string }[] } | undefined)?.beats ?? [];
    const timedBeats = (prev[4]?.data.beats as { index?: number; startSec: number; endSec: number }[] | undefined) ?? [];
    if (storyBeats.length > 0 && timedBeats.length > 0) {
      const { w, h } = RESOLUTIONS[ctx.config.format];
      const designMd = (prev[1]?.data.design as string | undefined)
        ?? (existsSync(join(ctx.projectDir, "DESIGN.md")) ? readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8") : "");
      const lines: SubtitleLine[] = timedBeats
        .map((tb, i) => ({ startSec: tb.startSec, endSec: tb.endSec, text: storyBeats[i]?.narration ?? "" }))
        .filter((l) => l.text.trim().length > 0);
      if (lines.length > 0) {
        const style: SubtitleStyle = {
          primaryColor: pickPrimaryColor(ctx.config.theme?.hue?.primary, designMd),
          fontName: "Noto Sans CJK SC",
          fontSizePx: Math.max(16, Math.round(h * 0.06)),
          marginVPx: Math.round(h * 0.05),
          width: w,
          height: h,
        };
        const assPath = join(ctx.projectDir, "renders", "subs.ass");
        writeFileSync(assPath, buildAss(lines, style));
        const burn = (ctx as unknown as { _burnSubtitles?: typeof burnSubtitles })._burnSubtitles ?? burnSubtitles;
        try {
          await burn(abs, assPath, abs);
          subsArtifact = "renders/subs.ass";
          ctx.log(`字幕烧录完成（${lines.length} 条）`);
        } catch (e) {
          ctx.log(`字幕烧录失败（保留无字幕视频）: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  const probe = await probeMedia(abs);
  const timelineSec = (prev[4]?.data.beats as { endSec: number }[] | undefined)?.at(-1)?.endSec ?? ctx.config.durationSec;
  const expected = timelineSec;
  const dev = Math.abs(probe.durationSec - expected) / expected;
  if (!probe.hasVideo || dev > 0.1) {
    return {
      status: "gate_failed", artifacts: [outPath], data: {},
      log: `渲染校验失败：时长 ${probe.durationSec.toFixed(1)}s vs 时间线 ${expected.toFixed(1)}s`,
      gateErrors: [`渲染校验失败：hasVideo=${probe.hasVideo}, duration=${probe.durationSec.toFixed(1)}s, 时间线=${expected.toFixed(1)}s, 偏差 ${(dev * 100).toFixed(0)}%`],
    };
  }
  return {
    status: "passed",
    artifacts: subsArtifact ? [outPath, subsArtifact] : [outPath],
    data: { durationSec: probe.durationSec, hasVideo: probe.hasVideo, subtitles: subsArtifact !== null },
    log: `渲染完成：${probe.durationSec.toFixed(1)}s${subsArtifact ? "（含字幕）" : ""}`,
  };
};
```

- [ ] **Step 4: 运行确认通过**

Run: `cd server && bun test test/step6-render.test.ts test/api.test.ts --timeout 60000`
Expected: PASS（原有用例 + 2 个新用例；api 解析 subtitles 不破坏现有用例）

- [ ] **Step 5: 全量服务端验证**

Run: `cd server && bun test --timeout 60000 && tsc --noEmit`
Expected: 全绿、无类型错误

- [ ] **Step 6: 提交**

```bash
git add server/src/types.ts server/src/api/server.ts server/src/pipeline/steps/step6-render.ts server/test/step6-render.test.ts
git commit -m "feat: burn ASS subtitles into rendered video (step6)"
```

---

### Task 4: 前端（字幕开关 + 汇总/详情展示）

**Files:**
- Modify: `web/src/types.ts`（JobConfigDto 增 `subtitles?: boolean`）
- Modify: `web/src/pages/NewJob.tsx`（state + 开关 UI + 提交 + 汇总卡）
- Modify: `web/src/pages/JobDetail.tsx:90-97`（清晰度旁加字幕行）

- [ ] **Step 1: 前端类型**

`web/src/types.ts` 的 `JobConfigDto` 加：

```ts
  subtitles?: boolean;
```

- [ ] **Step 2: NewJob 加开关**

`web/src/pages/NewJob.tsx`：

1. `const [voiceover, setVoiceover] = useState(true);` 后加：

```tsx
  const [subtitles, setSubtitles] = useState(true);
```

2. `submit` 的 `form.set("renderQuality", quality);` 后加：

```tsx
    form.set("subtitles", String(subtitles && voiceover));
```

3. 「配音」segmented 之后（音色块之前）加字幕块（配音关闭时禁用）：

```tsx
            <div>
              <label className="mb-1.5 block text-sm font-medium text-neutral-700 dark:text-neutral-200">字幕</label>
              <div className="segmented">
                <button type="button" disabled={!voiceover} data-active={subtitles && voiceover} onClick={() => setSubtitles(true)}>开启</button>
                <button type="button" disabled={!voiceover} data-active={!subtitles || !voiceover} onClick={() => setSubtitles(false)}>关闭</button>
              </div>
              {!voiceover && <p className="mt-1 text-[11px] text-neutral-400">配音关闭时无字幕</p>}
            </div>
```

4. 汇总卡「配音」行后加：

```tsx
              <div className="flex gap-3">
                <dt className="w-16 shrink-0 text-neutral-500">字幕</dt>
                <dd className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-300">{voiceover && subtitles ? "开启" : "关闭"}</dd>
              </div>
```

- [ ] **Step 3: JobDetail 加展示行**

`web/src/pages/JobDetail.tsx` 「清晰度」行后加：

```tsx
          <div className="flex gap-2">
            <dt className="shrink-0 text-neutral-500">字幕</dt>
            <dd className="min-w-0 text-neutral-700 dark:text-neutral-300">{job.config.subtitles === false ? "关闭" : "开启"}</dd>
          </div>
```

- [ ] **Step 4: 前端构建验证**

Run: `cd web && bun run build`
Expected: 类型检查 + 生产构建通过（tsc 无错误）

- [ ] **Step 5: 提交**

```bash
git add web/src/types.ts web/src/pages/NewJob.tsx web/src/pages/JobDetail.tsx
git commit -m "feat: add subtitle toggle to job wizard and detail"
```

---

### Task 5: 全量验证 + 收尾

- [ ] **Step 1: 全量测试**

Run: `cd server && bun test --timeout 60000 && tsc --noEmit`
Expected: 全绿、无类型错误

- [ ] **Step 2: 前端构建**

Run: `cd web && bun run build`
Expected: 通过

- [ ] **Step 3: 冒烟（可选，需真实 key + 约 14 分钟）**

Run: `cd server && bun run e2e`
Expected: 7 步全绿，产物含烧录字幕

- [ ] **Step 4: 提交收尾（如有遗留改动）**

```bash
git status && git add -A && git commit -m "chore: subtitle feature final verification"
```

- [ ] **Step 5: 更新 AGENTS.md 目录树（`subtitle/` 新增目录）**

在 `server/src/` 树中 `tts/` 行后加：

```
    │   │   ├── subtitle/           # ASS 字幕生成 + ffmpeg 烧录
```

```bash
git add AGENTS.md && git commit -m "docs: add subtitle module to AGENTS.md tree"
```
