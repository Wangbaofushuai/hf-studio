import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/db/store";
import { PipelineEngine, type Services } from "../src/pipeline/engine";
import type { JobConfig, StepFn } from "../src/types";

const cfg: JobConfig = {
  idea: "t", durationSec: 10, format: "landscape", voiceover: false,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "hf-conc-"));
  const store = new JobStore(join(dir, "jobs.db"));
  store.init();
  return { dir, store };
}

describe("PipelineEngine concurrency", () => {
  let dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  test("runs at most maxConcurrency jobs in parallel", async () => {
    const { dir, store } = newStore(); dirs.push(dir);
    let concurrent = 0; let peak = 0;
    const steps: StepFn[] = [async () => {
      concurrent++; peak = Math.max(peak, concurrent);
      await sleep(30);
      concurrent--;
      return { status: "passed", artifacts: [], data: {}, log: "ok" };
    }];
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir, maxConcurrency: 2 });
    const ids = [store.createJob(cfg), store.createJob(cfg), store.createJob(cfg)];
    await engine.processNext();
    expect(peak).toBe(2);
    for (const id of ids) expect(store.getJob(id)?.status).toBe("completed");
  });

  test("processes queued jobs in FIFO order", async () => {
    const { dir, store } = newStore(); dirs.push(dir);
    const order: string[] = [];
    const steps: StepFn[] = [async (ctx) => {
      order.push(ctx.jobId);
      await sleep(10);
      return { status: "passed", artifacts: [], data: {}, log: "ok" };
    }];
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir, maxConcurrency: 1 });
    const a = store.createJob(cfg); const b = store.createJob(cfg); const c = store.createJob(cfg);
    await engine.processNext();
    expect(order).toEqual([a, b, c]);
  });

  test("mid-run enqueue and rerun are picked up after slots free", async () => {
    const { dir, store } = newStore(); dirs.push(dir);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let slowId = "";
    const steps: StepFn[] = [
      async (ctx) => {
        order.push(`s0:${ctx.jobId}`);
        if (ctx.jobId === slowId) await gate;
        return { status: "passed", artifacts: [], data: {}, log: "ok" };
      },
      async (ctx) => { order.push(`s1:${ctx.jobId}`); return { status: "passed", artifacts: [], data: {}, log: "ok" }; },
    ];
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir, maxConcurrency: 1 });
    const rerunId = store.createJob(cfg);
    await engine.processNext(); // rerunId 完整跑完
    slowId = store.createJob(cfg);
    const drain = engine.processNext(); // 慢任务占住唯一槽位
    engine.rerunFrom(rerunId, 1);       // 入队，等待补位
    release();
    await drain;
    expect(store.getJob(slowId)?.status).toBe("completed");
    expect(store.getJob(rerunId)?.status).toBe("completed");
    expect(order).toEqual(["s0:" + rerunId, "s1:" + rerunId, "s0:" + slowId, "s1:" + slowId, "s1:" + rerunId]);
  });
});
