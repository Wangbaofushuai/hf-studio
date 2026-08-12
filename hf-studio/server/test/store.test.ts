import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/db/store";
import type { JobConfig, StepOutput } from "../src/types";

const cfg: JobConfig = {
  idea: "测试想法", durationSec: 15, format: "portrait", voiceover: true,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" },
  materials: { images: [], audio: null },
};

describe("JobStore", () => {
  let dir: string; let store: JobStore;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-store-"));
    store = new JobStore(join(dir, "jobs.db"));
    store.init();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("createJob returns id and persists config", () => {
    const id = store.createJob(cfg, "u1");
    const job = store.getJob(id);
    expect(job?.id).toBe(id);
    expect(job?.status).toBe("queued");
    expect(job?.config.idea).toBe("测试想法");
    expect(job?.userId).toBe("u1");
  });

  test("step lifecycle: begin → finish → outputs persisted", () => {
    const id = store.createJob(cfg);
    store.beginStep(id, 0);
    const out: StepOutput = { step: 0, status: "passed", artifacts: ["brief.json"], data: {}, log: "ok", attempts: 1 };
    store.finishStep(id, 0, out);
    expect(store.getLatestOutput(id, 0)?.log).toBe("ok");
    store.finishStep(id, 0, { ...out, attempts: 2, status: "gate_failed", error: "x" });
    // 同一步多次尝试只保留最新一条
    const latest = store.getLatestOutput(id, 0);
    expect(latest?.attempts).toBe(2);
    expect(latest?.status).toBe("gate_failed");
    expect(store.getStepOutputs(id).filter((o) => o.step === 0)).toHaveLength(1);
  });

  test("updateJob can replace config", () => {
    const id = store.createJob(cfg);
    store.updateJob(id, { config: { ...cfg, durationSec: 30 } });
    expect(store.getJob(id)?.config.durationSec).toBe(30);
  });

  test("updateJob can clear error back to null", () => {
    const id = store.createJob(cfg);
    store.updateJob(id, { error: "boom" });
    expect(store.getJob(id)?.error).toBe("boom");
    store.updateJob(id, { error: null });
    expect(store.getJob(id)?.error).toBeNull();
  });

  test("rerunFrom deletes downstream outputs and requeues", () => {
    const id = store.createJob(cfg);
    store.beginStep(id, 0); store.finishStep(id, 0, { step: 0, status: "passed", artifacts: [], data: {}, log: "a", attempts: 1 });
    store.beginStep(id, 1); store.finishStep(id, 1, { step: 1, status: "passed", artifacts: [], data: {}, log: "b", attempts: 1 });
    store.rerunFrom(id, 1);
    expect(store.getJob(id)?.status).toBe("queued");
    expect(store.getJob(id)?.currentStep).toBe(1);
    expect(store.getLatestOutput(id, 1)).toBeNull();
    expect(store.getLatestOutput(id, 0)?.log).toBe("a");
  });

  test("recover marks queued/running as failed", () => {
    const id = store.createJob(cfg);
    store.updateJob(id, { status: "running" });
    store.recover();
    expect(store.getJob(id)?.status).toBe("failed");
  });

  test("listJobs returns newest first", () => {
    const a = store.createJob(cfg); const b = store.createJob(cfg);
    const jobs = store.listJobs(10);
    expect(jobs[0].id).toBe(b);
    expect(jobs[1].id).toBe(a);
  });
});

describe("JobStore.listQueued", () => {
  let dir: string; let store: JobStore;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-store-q-"));
    store = new JobStore(join(dir, "jobs.db"));
    store.init();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("returns queued jobs in insertion order (FIFO)", () => {
    const id1 = store.createJob(cfg);
    const id2 = store.createJob(cfg);
    const id3 = store.createJob(cfg);
    store.updateJob(id2, { status: "running" }); // 排除非 queued
    const q = store.listQueued();
    expect(q.map((j) => j.id)).toEqual([id1, id3]);
  });
});
