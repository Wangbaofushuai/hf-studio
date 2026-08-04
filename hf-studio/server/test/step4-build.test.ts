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
  const llm = new LlmGateway(mockProviders, {
    transport: mockTransport(async (_p, body) => {
      const userMsg = String(body.messages.at(-1)?.content ?? "");
      const m = userMsg.match(/beat-(\d+)/);
      const id = m ? `beat-${m[1]}` : "beat-1";
      return { content: BEAT_HTML(id) };
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "hf-step4-"));
  writeFileSync(join(dir, "DESIGN.md"), "# DESIGN\n## Visual Theme\n暗色\n## Quick Reference\n#000 #fff\n## Component Stylings\n标题 80px\n## Spacing & Layout\n网格\n## Iteration Guide\n克制");
  let lintCalls = 0;
  const render = {
    lint: async () => {
      lintCalls++;
      return { errorCount: lintErrorCount, findings: lintErrorCount > 0 ? [{ rule: "test_rule", message: "bad html", severity: "error" }] : [] };
    },
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
    expect(built[1]).toMatchObject({ id: "beat-2", startSec: 4.2, endSec: 9 });
    // index.html 引用两个 beat 槽位
    const indexHtml = readFileSync(join((ctx as any).projectDir, "index.html"), "utf8");
    expect(indexHtml).toContain('data-composition-src="compositions/beat-1.html"');
    expect(indexHtml).toContain('data-composition-src="compositions/beat-2.html"');
  });

  test("lint failure returns gate_failed with lint errors", async () => {
    const { ctx, prev } = makeCtx(1);
    const r = await step4Build(ctx, prev);
    expect(r.status).toBe("gate_failed");
    expect(r.gateErrors?.join("; ")).toContain("bad html");
  });
});
