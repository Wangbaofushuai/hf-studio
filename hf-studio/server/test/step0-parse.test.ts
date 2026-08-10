import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step0Parse } from "../src/pipeline/steps/step0-parse";
import { LlmGateway } from "../src/llm/gateway";
import { mockTransport, mockProviders } from "./fixtures/mock-transport";
import type { StepContext, JobConfig } from "../src/types";

const cfg: JobConfig = {
  idea: "用三句话讲清太阳能发电原理", durationSec: 15, format: "portrait", voiceover: true,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};

const briefJson = JSON.stringify({
  title: "太阳能发电原理", summary: "三句话讲清原理", style: "现代极简深色",
  message: "太阳能如何变成电", audience: "普通观众", arc: "hook;story;proof",
  narrationLanguage: "zh-CN", beatCountHint: 3,
});

function makeCtx(transport: ReturnType<typeof mockTransport>): StepContext {
  const llm = new LlmGateway(mockProviders, { transport });
  const dir = mkdtempSync(join(tmpdir(), "hf-step0-"));
  return {
    jobId: "j1", projectDir: dir, config: cfg, llm,
    judge: null as never, store: null as never, render: null as never, tts: null as never,
    feedback: null, log: () => {},
  } as StepContext;
}

describe("step0Parse", () => {
  test("parses idea into brief and writes brief.json", async () => {
    const ctx = makeCtx(mockTransport(async (_p, body) => ({ content: briefJson })));
    const r = await step0Parse(ctx, []);
    expect(r.status).toBe("passed");
    const brief = r.data.brief as { title: string; beatCountHint: number };
    expect(brief.title).toBe("太阳能发电原理");
    expect(brief.beatCountHint).toBe(3);
    expect(readFileSync(join(ctx.projectDir, "brief.json"), "utf8")).toContain("太阳能");
  });

  test("invalid brief (missing fields) returns gate_failed", async () => {
    const ctx = makeCtx(mockTransport(async () => ({ content: JSON.stringify({ title: "x" }) })));
    const r = await step0Parse(ctx, []);
    expect(r.status).toBe("gate_failed");
    expect(r.gateErrors?.length).toBeGreaterThan(0);
  });

  test("rejects out-of-range beatCountHint with gate_failed", async () => {
    const ctx = makeCtx(mockTransport(async () => ({ content: JSON.stringify({ ...JSON.parse(briefJson), beatCountHint: 99 }) })));
    const r = await step0Parse(ctx, []);
    expect(r.status).toBe("gate_failed");
  });

  test("passes a sane timeoutMs to the LLM call (hang protection)", async () => {
    let seen: number | undefined;
    const ctx = makeCtx(mockTransport(async (_p, _b, timeoutMs) => {
      seen = timeoutMs;
      return { content: briefJson };
    }));
    await step0Parse(ctx, []);
    // 渠道挂起（如失效的 baseURL）时必须在有限时间内失败，而不是默认 600s 无限等待
    expect(seen).toBe(120_000);
  });
});
