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
    expect(readFileSync(join(dir, "compositions", "beat-1.html"), "utf8")).toContain("<html>fixed</html>"); // 修复结果写回文件
    expect(readFileSync(join(dir, "compositions", "beat-1.html"), "utf8")).toContain('data-composition-id="beat-1"'); // 根元素强制合规
    expect(r.data.snapshots).toHaveLength(2); // 修复后 check 通过，仍记录快照
  });

  test("repair uses sourceFile field (real check --json shape) when file is absent", async () => {
    // 真实 CLI 的 finding 字段是 sourceFile（无 file），且 sourceFile 可能是相对或绝对路径
    const dir = mkdtempSync(join(tmpdir(), "hf-step5-"));
    mkdirSync(join(dir, "compositions"), { recursive: true });
    const ORIGINAL = "<html>broken</html>";
    writeFileSync(join(dir, "compositions", "beat-1.html"), ORIGINAL);
    let checkRounds = 0;
    const render = {
      check: async () => {
        checkRounds++;
        return checkRounds === 1
          ? { ok: false, summary: { ok: false, runtime: { findings: [{ sourceFile: "compositions/beat-1.html", message: "boom", code: "console_error", severity: "error" }] } } }
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
      { step: 4, status: "passed" as const, artifacts: [], data: { beats: [{ id: "beat-1", startSec: 0, endSec: 4.2 }] }, log: "", attempts: 1 },
    ];
    const r = await step5Validate(ctx, prev as never);
    expect(r.status).toBe("passed");
    expect(chatCalls).toBe(1);
    expect(userPrompt).toContain("boom");
    expect(readFileSync(join(dir, "compositions", "beat-1.html"), "utf8")).toContain("<html>fixed</html>");
    expect(readFileSync(join(dir, "compositions", "beat-1.html"), "utf8")).toContain('data-composition-id="beat-1"');
  });

  test("findings pointing at directories or files without sourceFile/file are skipped (no EISDIR)", async () => {
    // 回归：旧实现按 f.file ?? "compositions" 分组，真实 finding 的 sourceFile 缺失时
    // 全部归到 "compositions" 目录 → readFileSync(EISDIR) 崩溃。修复后跳过非文件目标。
    const dir = mkdtempSync(join(tmpdir(), "hf-step5-"));
    mkdirSync(join(dir, "compositions"), { recursive: true });
    let checkRounds = 0;
    const render = {
      check: async () => {
        checkRounds++;
        return checkRounds === 1
          ? {
              ok: false,
              summary: {
                ok: false,
                runtime: {
                  findings: [
                    { sourceFile: "compositions", message: "dir target", code: "console_error" },
                    { message: "no file field at all", code: "console_error" },
                  ],
                },
              },
            }
          : { ok: true, summary: { ok: true } };
      },
      snapshot: async (at: number[]) => at.map((t) => `/tmp/snap-${t}.png`),
    };
    let chatCalls = 0;
    const llm = {
      chat: async () => { chatCalls++; return { content: "<html>fixed</html>" }; },
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
    expect(r.status).toBe("passed");
    expect(chatCalls).toBe(0); // 没有可修复的真实文件 → 零修复调用
  });

  test("repair resolves absolute sourceFile paths (real check --json emits absolute)", async () => {
    // 回归：真实 CLI 的 sourceFile 是绝对路径，旧实现 join(projectDir, 绝对路径) 拼出
    // 错误嵌套路径 → statSync 失败 → 修复被静默跳过 → check 永远不恢复 → 死循环重试。
    const dir = mkdtempSync(join(tmpdir(), "hf-step5-"));
    mkdirSync(join(dir, "compositions"), { recursive: true });
    const ORIGINAL = "<html>broken</html>";
    writeFileSync(join(dir, "compositions", "beat-1.html"), ORIGINAL);
    let checkRounds = 0;
    const render = {
      check: async () => {
        checkRounds++;
        return checkRounds === 1
          ? { ok: false, summary: { ok: false, runtime: { findings: [{ sourceFile: join(dir, "compositions/beat-1.html"), message: "boom", code: "console_error", severity: "error" }] } } }
          : { ok: true, summary: { ok: true } };
      },
      snapshot: async (at: number[]) => at.map((t) => `/tmp/snap-${t}.png`),
    };
    let chatCalls = 0;
    const llm = {
      chat: async () => { chatCalls++; return { content: "<html>fixed</html>" }; },
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
    expect(r.status).toBe("passed");
    expect(chatCalls).toBe(1); // 绝对路径也修复
    expect(readFileSync(join(dir, "compositions/beat-1.html"), "utf8")).toContain("<html>fixed</html>");
  });

  test("repair never touches index.html (host file owned by root-html.ts template)", async () => {
    // 回归：index.html 是 root-html.ts 确定性生成的宿主文件（root/audio/slot 的 data-start/duration
    // 已正确生成）。LLM 修复 + stripClipAttrs 会剥掉宿主定时属性 → check 报 missing_data_start
    // 死循环失败。宿主问题只应由 root-html.ts 保证，fix 循环必须跳过 index.html。
    const dir = mkdtempSync(join(tmpdir(), "hf-step5-"));
    const INDEX = '<div id="root" data-composition-id="root" data-start="0" data-duration="9" data-width="1920" data-height="1080"></div>';
    writeFileSync(join(dir, "index.html"), INDEX);
    let checkRounds = 0;
    const render = {
      check: async () => {
        checkRounds++;
        return checkRounds === 1
          ? { ok: false, summary: { ok: false, runtime: { findings: [{ sourceFile: join(dir, "index.html"), message: "boom", code: "console_error", severity: "error" }] } } }
          : { ok: true, summary: { ok: true } };
      },
      snapshot: async (at: number[]) => at.map((t) => `/tmp/snap-${t}.png`),
    };
    let chatCalls = 0;
    const llm = {
      chat: async () => { chatCalls++; return { content: "<html>fixed</html>" }; },
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
    expect(r.status).toBe("passed");
    expect(chatCalls).toBe(0); // index.html 不被 LLM 修复
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(INDEX); // 内容原样保留
  });
});
