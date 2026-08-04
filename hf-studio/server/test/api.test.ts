import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server";
import { JobStore } from "../src/db/store";
import { PipelineEngine } from "../src/pipeline/engine";
import type { AppConfig } from "../src/config";
import type { StepFn } from "../src/types";

const config: AppConfig = {
  providers: [], defaults: { model: "fake/model-a", judgeModel: "fake/model-a", judgeThreshold: 7 },
  tts: { defaultVoice: "zh-CN-XiaoxiaoNeural", defaultLanguage: "zh-CN" },
};

describe("API", () => {
  let dir: string; let store: JobStore; let server: ReturnType<typeof createServer>;
  const ran: string[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-api-"));
    store = new JobStore(join(dir, "jobs.db")); store.init();
    const steps: StepFn[] = [async (ctx: any) => { ran.push("step"); return { status: "passed", artifacts: [], data: {}, log: "ok" }; }];
    // judge 字段为 DEV：BYOK 任务走自定义渠道路径，引擎需要 services.judge.threshold 构造 Judge
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}), judge: { threshold: 7 } } as never, projectRoot: join(dir, "projects") });
    server = createServer({ store, engine, config, projectsRoot: join(dir, "projects"), tts: { listVoices: async () => [{ shortName: "zh-CN-XiaoxiaoNeural", gender: "Female", locale: "zh-CN" }] } as never });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const base = "http://localhost";

  test("POST /api/jobs creates job and enqueues", async () => {
    const form = new FormData();
    form.set("idea", "测试想法");
    form.set("durationSec", "15");
    form.set("format", "portrait");
    form.set("voiceover", "true");
    form.set("voice", "zh-CN-XiaoxiaoNeural");
    form.set("language", "zh-CN");
    form.set("model", "fake/model-a");
    const res = await server.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: form }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(store.getJob(id)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 50)); // 等引擎跑完
    expect(ran.length).toBe(1);
    expect(store.getJob(id)?.status).toBe("completed");
  });

  test("POST /api/jobs accepts BYOK providers field", async () => {
    const form = new FormData();
    form.set("idea", "带自定义渠道");
    form.set("durationSec", "10");
    form.set("format", "landscape");
    form.set("voiceover", "false");
    form.set("voice", "zh-CN-XiaoxiaoNeural");
    form.set("language", "zh-CN");
    form.set("model", "mykey/custom-model");
    form.set("providers", JSON.stringify([
      { id: "mykey", baseURL: "https://example.com/v1", apiKey: "sk-test", models: ["custom-model"] },
    ]));
    const res = await server.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: form }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(store.getJob(id)?.config.providers?.[0]).toMatchObject({ id: "mykey", apiKey: "sk-test", models: ["custom-model"] });
  });

  test("GET /api/jobs lists jobs", async () => {
    const res = await server.fetch(new Request(`${base}/api/jobs`));
    const { jobs } = (await res.json()) as { jobs: unknown[] };
    // 前两个用例各 POST 创建一个 job，故应为 2
    expect(jobs.length).toBe(2);
  });

  test("GET /api/jobs/:id returns detail with steps", async () => {
    const { jobs } = (await (await server.fetch(new Request(`${base}/api/jobs`))).json()) as { jobs: { id: string }[] };
    const res = await server.fetch(new Request(`${base}/api/jobs/${jobs[0].id}`));
    const body = (await res.json()) as { job: { status: string }; steps: unknown[] };
    expect(body.job.status).toBe("completed");
    expect(body.steps.length).toBe(1);
  });

  test("GET /api/models lists configured providers", async () => {
    const res = await server.fetch(new Request(`${base}/api/models`));
    const body = (await res.json()) as { default: string };
    expect(body.default).toBe("fake/model-a");
  });

  test("GET /api/voices filters by lang", async () => {
    const res = await server.fetch(new Request(`${base}/api/voices?lang=zh-CN`));
    const body = (await res.json()) as { voices: { shortName: string }[] };
    expect(body.voices[0].shortName).toContain("Xiaoxiao");
  });

  test("POST /api/jobs/:id/rerun with model override replaces default model", async () => {
    const { jobs } = (await (await server.fetch(new Request(`${base}/api/jobs`))).json()) as { jobs: { id: string; config: { models: { default: string } } }[] };
    const res = await server.fetch(new Request(`${base}/api/jobs/${jobs[0].id}/rerun`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: 0, model: "fake/model-b" }),
    }));
    expect(res.status).toBe(202);
    expect(store.getJob(jobs[0].id)?.config.models.default).toBe("fake/model-b");
  });

  test("POST /api/jobs/:id/rerun returns 409 while job is queued", async () => {
    const d = mkdtempSync(join(tmpdir(), "hf-api-q-"));
    const s = new JobStore(join(d, "jobs.db")); s.init();
    const engine = new PipelineEngine({ store: s, steps: [], services: { render: () => ({}), judge: { threshold: 7 } } as never, projectRoot: join(d, "projects") });
    const srv = createServer({ store: s, engine, config, projectsRoot: join(d, "projects"), tts: { listVoices: async () => [] } as never });
    try {
      // 直接建任务不入队 → 恒为 queued
      const id = s.createJob({ idea: "q", durationSec: 10, format: "landscape", voiceover: false, voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN", models: { default: "fake/model-a" }, materials: { images: [], audio: null } });
      expect(s.getJob(id)?.status).toBe("queued");
      const res = await srv.fetch(new Request(`${base}/api/jobs/${id}/rerun`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: 0 }) }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "任务正在运行中，请稍后重试" });
      expect(s.getJob(id)?.status).toBe("queued"); // 状态未被改动
      expect(s.getStepOutputs(id)).toHaveLength(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("POST /api/jobs/:id/rerun returns 409 while job is running and leaves state unchanged", async () => {
    const d = mkdtempSync(join(tmpdir(), "hf-api-r-"));
    const s = new JobStore(join(d, "jobs.db")); s.init();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const steps: StepFn[] = [async () => { await gate; return { status: "passed", artifacts: [], data: {}, log: "slow ok" }; }];
    const engine = new PipelineEngine({ store: s, steps, services: { render: () => ({}), judge: { threshold: 7 } } as never, projectRoot: join(d, "projects") });
    const srv = createServer({ store: s, engine, config, projectsRoot: join(d, "projects"), tts: { listVoices: async () => [] } as never });
    try {
      const form = new FormData();
      form.set("idea", "慢任务");
      form.set("durationSec", "10");
      form.set("format", "landscape");
      const res = await srv.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: form }));
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      // 等引擎进入 running（慢 step 阻塞在 gate 上）
      for (let i = 0; i < 200; i++) {
        if (s.getJob(id)?.status === "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(s.getJob(id)?.status).toBe("running");
      const rerun = await srv.fetch(new Request(`${base}/api/jobs/${id}/rerun`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: 0 }) }));
      expect(rerun.status).toBe(409);
      expect(await rerun.json()).toMatchObject({ error: "任务正在运行中，请稍后重试" });
      expect(s.getJob(id)?.status).toBe("running"); // 状态未被改动
      expect(s.getStepOutputs(id)).toHaveLength(0); // step_runs 未被并发破坏
      release();
      for (let i = 0; i < 200; i++) {
        if (s.getJob(id)?.status === "completed") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(s.getJob(id)?.status).toBe("completed"); // 放行后正常完成
      expect(s.getStepOutputs(id)).toHaveLength(1);
    } finally {
      release();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
