import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step2Storyboard } from "../src/pipeline/steps/step2-storyboard";
import { LlmGateway } from "../src/llm/gateway";
import { Judge } from "../src/judge/judge";
import { mockTransport, mockProviders } from "./fixtures/mock-transport";
import type { StepContext, JobConfig, Brief, StepOutput } from "../src/types";

const cfg: JobConfig = {
  idea: "t", durationSec: 15, format: "landscape", voiceover: true,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};
const brief: Brief = { title: "t", summary: "s", style: "极简", message: "m", audience: "a", arc: "hook;story", narrationLanguage: "zh-CN", beatCountHint: 3 };

const goodPayload = JSON.stringify({
  storyboardMd: "## Beat 1: 开场\n\n## Beat 2: 原理\n\n## Beat 3: 总结",
  scriptMd: "[Beat 1] 大家好\n[Beat 2] 太阳能板把光变成电\n[Beat 3] 谢谢观看",
  beats: [
    { title: "开场", narration: "大家好", mood: "明亮", techniques: ["kinetic-typography"], transitions: "淡入", assets: [], durationSec: 5 },
    { title: "原理", narration: "太阳能板把光变成电", mood: "清晰", techniques: ["svg-path-draw"], transitions: "位移", assets: [], durationSec: 5 },
    { title: "总结", narration: "谢谢观看", mood: "收束", techniques: ["typing-effect"], transitions: "淡出", assets: [], durationSec: 5 },
  ],
});

// judgeReply: 自定义评审响应（用于评审器返回非法 JSON 的回归测试）
function makeCtx(reply: string, judgeScore = 8, judgeReply?: string): StepContext {
  const llm = new LlmGateway(mockProviders, {
    transport: mockTransport(async (_p, body) => {
      const userMsg = String((body.messages as { role: string; content: string }[]).at(-1)?.content ?? "");
      if (userMsg.includes("评审")) {
        if (judgeReply !== undefined) return { content: judgeReply };
        return { content: JSON.stringify({ rubric: { clarity: judgeScore, pacing: judgeScore, visualRichness: judgeScore, match: judgeScore }, score: judgeScore, feedback: "ok" }) };
      }
      return { content: reply };
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "hf-step2-"));
  writeFileSync(join(dir, "DESIGN.md"), "# DESIGN\n## Visual Theme\n暗色\n## Quick Reference\n#000 #fff\n## Component Stylings\n标题\n## Spacing & Layout\n网格\n## Iteration Guide\n克制");
  const prev: StepOutput[] = [
    { step: 0, status: "passed", artifacts: [], data: { brief }, log: "", attempts: 1 },
    { step: 1, status: "passed", artifacts: [], data: { design: "# DESIGN" }, log: "", attempts: 1 },
  ];
  return {
    jobId: "j1", projectDir: dir, config: cfg, llm,
    judge: new Judge(llm, "fake/model-a", 7),
    store: null as never, render: null as never, tts: null as never,
    feedback: null, log: () => {}, _prev: prev,
  } as unknown as StepContext;
}

describe("step2Storyboard", () => {
  test("parses beats and writes STORYBOARD.md + SCRIPT.md", async () => {
    const ctx = makeCtx(goodPayload);
    const r = await step2Storyboard(ctx, (ctx as any)._prev);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toEqual(expect.arrayContaining(["STORYBOARD.md", "SCRIPT.md"]));
    const beats = r.data.storyboard as { beats: { title: string; durationSec: number }[] };
    expect(beats.beats).toHaveLength(3);
    expect(beats.beats[1].durationSec).toBe(5);
  });

  test("duration sum mismatch returns gate_failed", async () => {
    const bad = JSON.parse(goodPayload);
    bad.beats[0].durationSec = 30; // 总和 40s vs 目标 15s，偏差 >20%
    const ctx = makeCtx(JSON.stringify(bad));
    const r = await step2Storyboard(ctx, (ctx as any)._prev);
    expect(r.status).toBe("gate_failed");
    expect(r.gateErrors?.[0]).toContain("时长");
  });

  test("empty narration with voiceover=true returns gate_failed", async () => {
    const bad = JSON.parse(goodPayload);
    bad.beats[0].narration = "";
    const ctx = makeCtx(JSON.stringify(bad));
    const r = await step2Storyboard(ctx, (ctx as any)._prev);
    expect(r.status).toBe("gate_failed");
  });

  test("low judge score returns judge_failed", async () => {
    const ctx = makeCtx(goodPayload, 5);
    const r = await step2Storyboard(ctx, (ctx as any)._prev);
    expect(r.status).toBe("judge_failed");
    expect(r.judge?.score).toBe(5);
  });

  test("judge returning invalid JSON returns judge_failed with error feedback", async () => {
    const ctx = makeCtx(goodPayload, 8, "这不是 JSON");
    const r = await step2Storyboard(ctx, (ctx as any)._prev);
    expect(r.status).toBe("judge_failed");
    expect(r.judge?.score).toBe(0);
    expect(r.judge?.feedback).toContain("评审器调用失败");
  });
});
