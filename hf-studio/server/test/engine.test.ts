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

  test("drain re-scans: mid-drain rerun is picked up by the in-flight drain", async () => {
    const order: string[] = [];
    let release!: () => void;
    let slowId = ""; // 先声明：慢任务 id 在首轮 drain 之后才生成，步骤闭包需提前可见
    const gate = new Promise<void>((r) => { release = r; });
    const steps: StepFn[] = [
      async (ctx) => {
        order.push(`s0:${ctx.jobId}`);
        if (ctx.jobId === slowId) await gate; // 慢任务：阻塞在 step0，模拟长时间运行
        return { status: "passed", artifacts: [], data: {}, log: "ok" };
      },
      async (ctx) => { order.push(`s1:${ctx.jobId}`); return { status: "passed", artifacts: [], data: {}, log: "ok" }; },
    ];
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir });

    // 先让 rerunId 完整跑完，作为稍后 rerun 的目标
    const rerunId = store.createJob(cfg);
    await engine.processNext();
    expect(store.getJob(rerunId)?.status).toBe("completed");
    expect(store.getStepOutputs(rerunId)).toHaveLength(2);

    // 慢任务开始 drain；processNext 返回时 drain 已同步执行到 step0 的 await gate。
    // 此时对另一个已完成任务发起 rerunFrom —— 它只入队，不新起 drain（单飞 join）。
    slowId = store.createJob(cfg);
    const drain = engine.processNext();
    engine.rerunFrom(rerunId, 1);
    release();
    await drain;

    // 两个任务都必须完成：rerun 由在途 drain 的重扫兜住，无需再次显式 enqueue
    expect(store.getJob(slowId)?.status).toBe("completed");
    expect(store.getJob(rerunId)?.status).toBe("completed");
    expect(order).toEqual(["s0:" + rerunId, "s1:" + rerunId, "s0:" + slowId, "s1:" + slowId, "s1:" + rerunId]);
  });
});
