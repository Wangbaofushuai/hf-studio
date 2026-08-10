import { describe, expect, test } from "bun:test";
import { Judge } from "../src/judge/judge";
import { LlmGateway } from "../src/llm/gateway";
import { mockTransport, mockProviders } from "./fixtures/mock-transport";
import type { Brief } from "../src/types";

const brief: Brief = {
  title: "测试", summary: "s", style: "极简", message: "m", audience: "a", arc: "hook",
  narrationLanguage: "zh-CN", beatCountHint: 4,
};

describe("Judge", () => {
  test("score parses rubric JSON and passes at threshold", async () => {
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async () => ({
        content: JSON.stringify({ rubric: { clarity: 8, pacing: 8, visualRichness: 8, match: 8 }, score: 8, feedback: "不错" }),
      })),
    });
    const judge = new Judge(gw, "fake/model-a", 7);
    const r = await judge.score("design", "# DESIGN\n...", brief);
    expect(r.score).toBe(8);
    expect(judge.passes(r)).toBe(true);
  });

  test("low score fails threshold", async () => {
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async () => ({
        content: JSON.stringify({ rubric: { clarity: 5, pacing: 5, visualRichness: 5, match: 5 }, score: 5, feedback: "太单调" }),
      })),
    });
    const judge = new Judge(gw, "fake/model-a", 7);
    const r = await judge.score("storyboard", "# STORYBOARD\n...", brief);
    expect(judge.passes(r)).toBe(false);
  });

  test("passes a sane timeoutMs to the LLM call (hang protection)", async () => {
    let seen: number | undefined;
    const gw = new LlmGateway(mockProviders, {
      transport: mockTransport(async (_p, _b, timeoutMs) => {
        seen = timeoutMs;
        return { content: JSON.stringify({ rubric: { clarity: 8, pacing: 8, visualRichness: 8, match: 8 }, score: 8, feedback: "不错" }) };
      }),
    });
    const judge = new Judge(gw, "fake/model-a", 7);
    await judge.score("design", "# DESIGN\n...", brief);
    // 评审器挂起同样卡死任务，必须有限超时
    expect(seen).toBe(120_000);
  });
});
