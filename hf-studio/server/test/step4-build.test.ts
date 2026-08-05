import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step4Build } from "../src/pipeline/steps/step4-build";
import { LlmGateway } from "../src/llm/gateway";
import { mockTransport, mockProviders } from "./fixtures/mock-transport";
import type { StepContext, JobConfig, StepOutput } from "../src/types";

const cfg: JobConfig = {
  idea: "t", durationSec: 9, format: "landscape", voiceover: true,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};

const BEAT_HTML = (id: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"/></head><body>
<template>
<style>#root { position: absolute; inset: 0; background: #000; color: #fff; }</style>
<div id="root" data-composition-id="${id}" data-width="1920" data-height="1080">
  <div id="${id}-title" class="clip" data-start="0" data-duration="2" data-track-index="1" style="font-size:80px">标题</div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.fromTo("#${id}-title", { opacity: 0 }, { opacity: 1, duration: 1 }, 0);
window.__timelines["${id}"] = tl;
</script>
</template></body></html>`;

function makeCtx(lintErrorCount: number): { ctx: StepContext; prev: StepOutput[]; lintCalls: () => number } {
  return makeCtxWithLint(async () => ({
    errorCount: lintErrorCount,
    findings: lintErrorCount > 0 ? [{ rule: "test_rule", message: "bad html", severity: "error" }] : [],
  }));
}

/** 灵活版 makeCtx：lint mock 可自定义（模拟真实 CLI 的 missing_or_empty_sub_composition 等） */
function makeCtxWithLint(lint: () => Promise<{
  ok?: boolean; errorCount?: number;
  findings: { rule?: string; code?: string; message: string; severity: string }[];
}>): { ctx: StepContext; prev: StepOutput[]; lintCalls: () => number } {
  const llm = new LlmGateway(mockProviders, {
    transport: mockTransport(async (_p, body) => {
      const userMsg = String((body.messages as { role: string; content: string }[]).at(-1)?.content ?? "");
      const m = userMsg.match(/beat-(\d+)/);
      const id = m ? `beat-${m[1]}` : "beat-1";
      return { content: BEAT_HTML(id) };
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "hf-step4-"));
  writeFileSync(join(dir, "DESIGN.md"), "# DESIGN\n## Visual Theme\n暗色\n## Quick Reference\n#000 #fff\n## Component Stylings\n标题 80px\n## Spacing & Layout\n网格\n## Iteration Guide\n克制");
  let lintCalls = 0;
  const render = {
    lint: async () => { lintCalls++; return lint(); },
  };
  const prev: StepOutput[] = [
    { step: 0, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
    { step: 1, status: "passed", artifacts: [], data: { design: "# DESIGN" }, log: "", attempts: 1 },
    { step: 2, status: "passed", artifacts: [], data: { storyboard: { beats: [{ id: "beat-1", narration: "第一句", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 4.2 }, { id: "beat-2", narration: "第二句", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 4.8 }] } }, log: "", attempts: 1 },
    { step: 3, status: "passed", artifacts: [], data: { boundaries: [{ index: 1, startSec: 0, endSec: 4.2 }, { index: 2, startSec: 4.2, endSec: 9 }] }, log: "", attempts: 1 },
  ];
  const ctx = {
    jobId: "j1", projectDir: dir, config: cfg,
    llm, render, feedback: null, log: () => {},
  } as unknown as StepContext;
  return { ctx, prev, lintCalls: () => lintCalls };
}

/** 可定制 durationSec 与 boundaries 的构建 ctx（用于软目标收尾测试） */
function makeCtxForBoundaries(durationSec: number, boundaries: { index: number; startSec: number; endSec: number }[]) {
  const llm = new LlmGateway(mockProviders, {
    transport: mockTransport(async (_p, body) => {
      const userMsg = String((body.messages as { role: string; content: string }[]).at(-1)?.content ?? "");
      const m = userMsg.match(/beat-(\d+)/);
      const id = m ? `beat-${m[1]}` : "beat-1";
      return { content: BEAT_HTML(id) };
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "hf-step4t-"));
  writeFileSync(join(dir, "DESIGN.md"), "# DESIGN\n## Visual Theme\n暗色\n## Quick Reference\n#000 #fff\n## Component Stylings\n标题 80px\n## Spacing & Layout\n网格\n## Iteration Guide\n克制");
  const render = { lint: async () => ({ ok: true, errorCount: 0, findings: [] as unknown[] }) };
  const prev: StepOutput[] = [
    { step: 0, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
    { step: 1, status: "passed", artifacts: [], data: { design: "# DESIGN" }, log: "", attempts: 1 },
    { step: 2, status: "passed", artifacts: [], data: { storyboard: { beats: [{ id: "beat-1", narration: "a", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 4 }, { id: "beat-2", narration: "b", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 4 }] } }, log: "", attempts: 1 },
    { step: 3, status: "passed", artifacts: [], data: { boundaries }, log: "", attempts: 1 },
  ];
  const ctx = {
    jobId: "j1", projectDir: dir, config: { ...cfg, durationSec },
    llm, render, feedback: null, log: () => {},
  } as unknown as StepContext;
  return { ctx, prev };
}

describe("step4Build", () => {
  test("generates index.html and one composition per beat with lint passing", async () => {
    const { ctx, prev } = makeCtx(0);
    const r = await step4Build(ctx, prev);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toEqual(expect.arrayContaining([
      "index.html",
      "compositions/beat-1.html",
      "compositions/beat-2.html",
    ]));
    expect(existsSync(join((ctx as any).projectDir, "index.html"))).toBe(true);
    const built = r.data.beats as { id: string; startSec: number; endSec: number }[];
    expect(built).toHaveLength(2);
    expect(built[0]).toMatchObject({ id: "beat-1", startSec: 0, endSec: 4.2 });
    // 软目标收尾：totalReal=9、target=9 → tailHold=max(0.6, min(0,4.5))=0.6 → 末 beat 补到 9.6
    expect(built[1]).toMatchObject({ id: "beat-2", startSec: 4.2, endSec: 9.6 });
    expect(r.data.finalEndSec).toBeCloseTo(9.6, 1);
    // index.html 引用两个 beat 槽位，root/narration 总时长用 finalEndSec(9.6)
    const indexHtml = readFileSync(join((ctx as any).projectDir, "index.html"), "utf8");
    expect(indexHtml).toContain('data-composition-src="compositions/beat-1.html"');
    expect(indexHtml).toContain('data-composition-src="compositions/beat-2.html"');
    expect(indexHtml).toContain('data-duration="9.6"');
    expect(indexHtml).toContain('id="narration"');
  });

  test("lint failure returns gate_failed with lint errors", async () => {
    const { ctx, prev } = makeCtx(1);
    const r = await step4Build(ctx, prev);
    expect(r.status).toBe("gate_failed");
    expect(r.gateErrors?.join("; ")).toContain("bad html");
  });

  test("missing referenced-file lint findings do not fail the per-beat attempt", async () => {
    // 模拟真实 CLI：index.html 先引用全部 beat，逐 beat 写入时尚未写入的合成
    // 产生 missing_or_empty_sub_composition（message 含 "does not exist"）。这类
    // finding 在逐 beat 阶段必须被过滤；全部写完后最终 lint 无错误 → 通过。
    let calls = 0;
    const { ctx, prev, lintCalls } = makeCtxWithLint(async () => {
      calls++;
      const missing = ["beat-1", "beat-2"].slice(calls); // 第 1 次: beat-2 缺失; 第 2 次起: 无
      return {
        ok: missing.length === 0,
        errorCount: missing.length,
        findings: missing.map((id) => ({
          code: "missing_or_empty_sub_composition",
          message: `data-composition-src references "compositions/${id}.html", but the file does not exist.`,
          severity: "error",
        })),
      };
    });
    const r = await step4Build(ctx, prev);
    expect(r.status).toBe("passed");
    expect(r.data.beats).toHaveLength(2);
    expect(lintCalls()).toBe(3); // 2 次逐 beat + 1 次最终完整 lint
    expect(existsSync(join((ctx as any).projectDir, "compositions/beat-2.html"))).toBe(true);
  });

  test("final full lint failure after all beats written returns gate_failed", async () => {
    let calls = 0;
    const { ctx, prev } = makeCtxWithLint(async () => {
      calls++;
      if (calls <= 2) {
        const missing = ["beat-1", "beat-2"].slice(calls);
        return {
          ok: missing.length === 0,
          errorCount: missing.length,
          findings: missing.map((id) => ({
            code: "missing_or_empty_sub_composition",
            message: `data-composition-src references "compositions/${id}.html", but the file does not exist.`,
            severity: "error",
          })),
        };
      }
      // 最终完整 lint：真实错误（不是缺失引用）→ 必须 gate_failed
      return {
        ok: false,
        errorCount: 1,
        findings: [{ rule: "test_rule", code: "real_error", message: "final bad html", severity: "error" }],
      };
    });
    const r = await step4Build(ctx, prev);
    expect(r.status).toBe("gate_failed");
    expect(r.gateErrors?.join("; ")).toContain("final bad html");
    expect(r.data.beats).toHaveLength(2); // 两个 beat 都已写入
  });

  test("markdown code fences around LLM output are stripped before writing", async () => {
    // 推理模型习惯性用 ```html ... ``` 包裹输出——直接写盘会让 hyperframes 解析失败
    // （lint 报 root_missing_composition_id 等，E2E 实测跨轮次全败于此）
    let calls = 0;
    const { ctx, prev } = makeCtxWithLint(async () => {
      calls++;
      const missing = ["beat-1", "beat-2"].slice(calls);
      return {
        ok: missing.length === 0,
        errorCount: missing.length,
        findings: missing.map((id) => ({
          code: "missing_or_empty_sub_composition",
          message: `data-composition-src references "compositions/${id}.html", but the file does not exist.`,
          severity: "error",
        })),
      };
    });
    // 让 mock LLM 输出带围栏的 HTML
    const llm = new LlmGateway(mockProviders, {
      transport: mockTransport(async () => ({
        content: "```html\n" + BEAT_HTML("beat-1") + "\n```",
      })),
    });
    (ctx as any).llm = llm;
    const r = await step4Build(ctx, prev);
    expect(r.status).toBe("passed");
    const written = readFileSync(join((ctx as any).projectDir, "compositions/beat-1.html"), "utf8");
    expect(written.startsWith("```")).toBe(false);
    expect(written.startsWith("<!doctype html>")).toBe(true);
    expect(written).not.toContain("```");
  });

  test("soft-target tail hold: short real total extends last beat to target", async () => {
    // totalReal=40, target=60 → tailHold=min(20,30)=20 → 末 beat endSec = 40+20 = 60
    const { ctx, prev } = makeCtxForBoundaries(60, [
      { index: 1, startSec: 0, endSec: 20 },
      { index: 2, startSec: 20, endSec: 40 },
    ]);
    const r = await step4Build(ctx, prev);
    expect(r.status).toBe("passed");
    const last = (r.data.beats as { id: string; endSec: number }[]).at(-1)!;
    expect(last.endSec).toBeCloseTo(60, 1);
    expect(r.data.finalEndSec).toBeCloseTo(60, 1);
  });

  test("soft-target tail hold: real total already over target keeps +0.6s", async () => {
    // totalReal=70 > target=60 → min(-10, 30) 为负 → tailHold=0.6 → 末 beat endSec = 70.6
    const { ctx, prev } = makeCtxForBoundaries(60, [
      { index: 1, startSec: 0, endSec: 30 },
      { index: 2, startSec: 30, endSec: 70 },
    ]);
    const r = await step4Build(ctx, prev);
    expect(r.status).toBe("passed");
    const last = (r.data.beats as { id: string; endSec: number }[]).at(-1)!;
    expect(last.endSec).toBeCloseTo(70.6, 1);
    expect(r.data.finalEndSec).toBeCloseTo(70.6, 1);
  });

  test("soft-target tail hold: slightly short real total rounds up to target", async () => {
    // totalReal=14, target=15 → min(1, 7.5)=1 → 末 beat endSec = 14+1 = 15
    const { ctx, prev } = makeCtxForBoundaries(15, [
      { index: 1, startSec: 0, endSec: 7 },
      { index: 2, startSec: 7, endSec: 14 },
    ]);
    const r = await step4Build(ctx, prev);
    expect(r.status).toBe("passed");
    const last = (r.data.beats as { id: string; endSec: number }[]).at(-1)!;
    expect(last.endSec).toBeCloseTo(15, 1);
    expect(r.data.finalEndSec).toBeCloseTo(15, 1);
  });
});
