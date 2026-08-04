import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step1Design } from "../src/pipeline/steps/step1-design";
import { LlmGateway } from "../src/llm/gateway";
import { Judge } from "../src/judge/judge";
import { mockTransport, mockProviders } from "./fixtures/mock-transport";
import type { StepContext, JobConfig, Brief } from "../src/types";

const cfg: JobConfig = {
  idea: "t", durationSec: 10, format: "landscape", voiceover: false,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};
const brief: Brief = { title: "t", summary: "s", style: "极简", message: "m", audience: "a", arc: "hook", narrationLanguage: "zh-CN", beatCountHint: 4 };
const DESIGN = "# DESIGN\n\n## Visual Theme\n暗色极简\n## Quick Reference\n#000000 #ffffff\n## Component Stylings\n标题 80px\n## Spacing & Layout\n16px 网格\n## Iteration Guide\n不要花哨";

function makeCtx(genReply: string, judgeScore = 8): StepContext {
  const llm = new LlmGateway(mockProviders, {
    transport: mockTransport(async (_p, body) => {
      const userMsg = String(body.messages.at(-1)?.content ?? "");
      if (userMsg.includes("评审")) {
        return { content: JSON.stringify({ rubric: { clarity: judgeScore, pacing: judgeScore, visualRichness: judgeScore, match: judgeScore }, score: judgeScore, feedback: "ok" }) };
      }
      return { content: genReply };
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), "hf-step1-"));
  writeFileSync(join(dir, "brief.json"), JSON.stringify(brief));
  return {
    jobId: "j1", projectDir: dir, config: cfg, llm,
    judge: new Judge(llm, "fake/model-a", 7),
    store: null as never, render: null as never, tts: null as never,
    feedback: null, log: () => {},
  } as unknown as StepContext;
}

describe("step1Design", () => {
  test("writes DESIGN.md and passes judge", async () => {
    const ctx = makeCtx(DESIGN);
    const r = await step1Design(ctx, []);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toContain("DESIGN.md");
    expect(readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8")).toContain("Visual Theme");
    expect(r.judge?.score).toBe(8);
  });

  test("low judge score returns judge_failed with feedback", async () => {
    const ctx = makeCtx(DESIGN, 5);
    const r = await step1Design(ctx, []);
    expect(r.status).toBe("judge_failed");
    expect(r.judge?.score).toBe(5);
  });
});
