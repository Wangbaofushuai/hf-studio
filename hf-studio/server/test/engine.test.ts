import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/db/store";
import { PipelineEngine, type Services } from "../src/pipeline/engine";
import type { JobConfig, StepContext, StepFn, StepOutput } from "../src/types";

const cfg: JobConfig = {
  idea: "t", durationSec: 10, format: "landscape", voiceover: false,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};

function ctxOf(jobId: string, projectDir: string): StepContext {
  return {
    jobId, projectDir, config: cfg,
    llm: null as never, judge: null as never, store: null as never, render: null as never, tts: null as never,
    feedback: null, log: () => {},
  };
}

describe("PipelineEngine", () => {
  let dir: string; let store: JobStore;
  const events: string[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-engine-"));
    store = new JobStore(join(dir, "jobs.db")); store.init();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("runs all steps to completion in order", async () => {
    const ran: number[] = [];
    const steps: StepFn[] = [0, 1, 2, 3].map((n) => async (ctx, prev) => {
      ran.push(n);
      expect(prev.length).toBe(n); // 每步看到前序输出
      return { status: "passed", artifacts: [], data: { n }, log: `step${n}` };
    });
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir });
    const jobId = store.createJob(cfg);
    engine.onEvent((e) => events.push(e.type));
    await engine.processNext();
    expect(ran).toEqual([0, 1, 2, 3]);
    expect(store.getJob(jobId)?.status).toBe("completed");
    expect(store.getStepOutputs(jobId).map((o) => o.step)).toEqual([0, 1, 2, 3]);
  });

  test("gate_failed retries up to 3 then needs_review", async () => {
    let attempts = 0;
    const steps: StepFn[] = [async (ctx) => {
      attempts++;
      ctx.feedback = `gate error ${attempts}`;
      return { status: "gate_failed", artifacts: [], data: {}, log: "x", gateErrors: [`err${attempts}`] };
    }];
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir });
    const jobId = store.createJob(cfg);
    await engine.processNext();
    expect(attempts).toBe(4); // 1 次原始 + 3 次重试
    expect(store.getJob(jobId)?.status).toBe("needs_review");
    const out = store.getStepOutputs(jobId)[0];
    expect(out.attempts).toBe(4);
  });

  test("judge_failed retries up to 2 then needs_review", async () => {
    let attempts = 0;
    const steps: StepFn[] = [async (ctx) => {
      attempts++;
      return { status: "judge_failed", artifacts: [], data: {}, log: "y", judge: { score: 5, rubric: {}, feedback: `fb${attempts}` } };
    }];
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir });
    const jobId = store.createJob(cfg);
    await engine.processNext();
    expect(attempts).toBe(3); // 1 次原始 + 2 次重生成
    expect(store.getJob(jobId)?.status).toBe("needs_review");
  });

  test("rerunFrom resumes at requested step", async () => {
    const ran: number[] = [];
    const steps: StepFn[] = [0, 1, 2].map((n) => async (ctx, prev) => {
      ran.push(n);
      return { status: "passed", artifacts: [], data: { n }, log: `s${n}` };
    });
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir });
    const jobId = store.createJob(cfg);
    await engine.processNext();
    ran.length = 0;
    engine.rerunFrom(jobId, 1);
    await engine.processNext();
    expect(ran).toEqual([1, 2]); // 只重跑 step1 及之后
    expect(store.getJob(jobId)?.status).toBe("completed");
  });

  test("initProject scaffolds project before step0 when render provides it", async () => {
    const calls: string[] = [];
    const engine = new PipelineEngine({
      store,
      steps: [async (ctx) => {
        calls.push(`step0:${ctx.jobId}`);
        return { status: "passed", artifacts: [], data: {}, log: "ok" };
      }],
      services: {
        render: (projectDir: string) => ({ initProject: async () => { calls.push(`init:${projectDir}`); } }),
      } as unknown as Services,
      projectRoot: dir,
    });
    const jobId = store.createJob(cfg);
    await engine.processNext();
    expect(calls[0]).toBe(`init:${join(dir, jobId)}`);
    expect(calls[1]).toBe(`step0:${jobId}`);
  });
});
