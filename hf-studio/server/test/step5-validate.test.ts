import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step5Validate } from "../src/pipeline/steps/step5-validate";
import type { StepContext, JobConfig } from "../src/types";

const cfg: JobConfig = {
  idea: "t", durationSec: 9, format: "landscape", voiceover: true,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};

describe("step5Validate", () => {
  test("check ok passes and records snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step5-"));
    const render = {
      check: async () => ({ ok: true, summary: { ok: true } }),
      snapshot: async (at: number[]) => at.map((t) => `/tmp/snap-${t}.png`),
    };
    const ctx = { jobId: "j1", projectDir: dir, config: cfg, render, feedback: null, log: () => {} } as unknown as StepContext;
    // prev 按 step 编号索引（与引擎/step4 测试同约定）：step4 的输出在索引 4
    const prev = [
      { step: 0, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 1, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 2, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 3, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 4, status: "passed" as const, artifacts: [], data: { beats: [{ id: "beat-1", startSec: 0, endSec: 4.2 }, { id: "beat-2", startSec: 4.2, endSec: 9 }] }, log: "", attempts: 1 },
    ];
    const r = await step5Validate(ctx, prev as never);
    expect(r.status).toBe("passed");
    expect(r.data.snapshots).toHaveLength(2); // 每 beat 中点
  });

  test("check failing twice returns gate_failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step5-"));
    const render = {
      check: async () => ({ ok: false, summary: { ok: false, runtime: { findings: [{ file: "compositions/beat-1.html", message: "boom" }] } } }),
      snapshot: async () => [],
    };
    const llm = {
      chat: async () => ({ content: "<html>fixed</html>" }),
    };
    const ctx = { jobId: "j1", projectDir: dir, config: cfg, render, llm, feedback: null, log: () => {} } as unknown as StepContext;
    const prev = [
      { step: 0, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 1, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 2, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 3, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 4, status: "passed" as const, artifacts: [], data: { beats: [{ id: "beat-1", startSec: 0, endSec: 4.2 }] }, log: "", attempts: 1 },
    ];
    const r = await step5Validate(ctx, prev as never);
    expect(r.status).toBe("gate_failed");
    expect(r.gateErrors?.length).toBeGreaterThan(0);
  });

  test("repair writes fix per affected file when check recovers on round 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step5-"));
    mkdirSync(join(dir, "compositions"), { recursive: true });
    const ORIGINAL = "<html>broken</html>";
    writeFileSync(join(dir, "compositions", "beat-1.html"), ORIGINAL);
    let checkRounds = 0;
    const render = {
      check: async () => {
        checkRounds++;
        return checkRounds === 1
          ? { ok: false, summary: { ok: false, runtime: { findings: [{ file: "compositions/beat-1.html", message: "boom", rule: "r1" }] } } }
          : { ok: true, summary: { ok: true } };
      },
      snapshot: async (at: number[]) => at.map((t) => `/tmp/snap-${t}.png`),
    };
    let chatCalls = 0;
    let userPrompt = "";
    const llm = {
      chat: async (p: { messages: { role: string; content: string }[] }) => {
        chatCalls++;
        userPrompt = String(p.messages.at(-1)?.content ?? "");
        return { content: "<html>fixed</html>" };
      },
    };
    const ctx = { jobId: "j1", projectDir: dir, config: cfg, render, llm, feedback: null, log: () => {} } as unknown as StepContext;
    const prev = [
      { step: 0, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 1, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 2, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 3, status: "passed" as const, artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 4, status: "passed" as const, artifacts: [], data: { beats: [{ id: "beat-1", startSec: 0, endSec: 4.2 }, { id: "beat-2", startSec: 4.2, endSec: 9 }] }, log: "", attempts: 1 },
    ];
    const r = await step5Validate(ctx, prev as never);
    expect(r.status).toBe("passed");
    expect(chatCalls).toBe(1); // 每个受影响文件每轮恰好一次修复调用
    expect(userPrompt).toContain("boom"); // finding 消息进入 prompt
    expect(userPrompt).toContain(ORIGINAL); // 文件原内容进入 prompt
    expect(readFileSync(join(dir, "compositions", "beat-1.html"), "utf8")).toBe("<html>fixed</html>"); // 修复结果写回文件
    expect(r.data.snapshots).toHaveLength(2); // 修复后 check 通过，仍记录快照
  });
});
