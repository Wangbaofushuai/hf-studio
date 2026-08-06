import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server";
import { JobStore } from "../src/db/store";
import { PipelineEngine } from "../src/pipeline/engine";
import type { AppConfig } from "../src/config";
import type { StepFn } from "../src/types";

const config: AppConfig = {
  presetChannels: [
    { id: "fake", name: "Fake", baseURL: "http://localhost:1/v1", models: ["model-a"] },
    { id: "custom", name: "自定义渠道", baseURL: "", models: [] },
  ],
  defaults: { model: "fake/model-a", judgeModel: "fake/model-a", judgeThreshold: 7 },
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
    // 渠道存储注入内存实现，避免污染真实 data/channels.json
    let channelData: Record<string, { apiKey: string; baseURL?: string; models?: string[] }> = {};
    server = createServer({
      store, engine, config, projectsRoot: join(dir, "projects"),
      tts: { listVoices: async () => [{ shortName: "zh-CN-XiaoxiaoNeural", gender: "Female", locale: "zh-CN" }] } as never,
      channels: {
        load: () => channelData,
        save: (id, v) => { channelData = { ...channelData, [id]: v }; },
        remove: (id) => { const { [id]: _removed, ...rest } = channelData; channelData = rest; },
      },
    });
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

  test("POST /api/jobs accepts theme preset and renderQuality", async () => {
    const form = new FormData();
    form.set("idea", "带主题预设");
    form.set("durationSec", "10");
    form.set("format", "landscape");
    form.set("voiceover", "false");
    form.set("voice", "zh-CN-XiaoxiaoNeural");
    form.set("language", "zh-CN");
    form.set("model", "fake/model-a");
    form.set("theme", JSON.stringify({ id: "tech", hue: { primary: "#0f172a", accent: "#7dd3fc" } }));
    form.set("renderQuality", "high");
    const res = await server.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: form }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(store.getJob(id)?.config.theme).toMatchObject({ id: "tech", hue: { primary: "#0f172a", accent: "#7dd3fc" } });
    expect(store.getJob(id)?.config.renderQuality).toBe("high");
  });

  test("POST /api/jobs accepts theme without hue and defaults renderQuality to standard", async () => {
    const form = new FormData();
    form.set("idea", "主题无 hue");
    form.set("durationSec", "10");
    form.set("format", "square");
    form.set("model", "fake/model-a");
    form.set("theme", JSON.stringify({ id: "nature" }));
    const res = await server.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: form }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(store.getJob(id)?.config.theme).toEqual({ id: "nature" });
    expect(store.getJob(id)?.config.renderQuality).toBe("standard");
  });

  test("POST /api/jobs rejects invalid theme JSON and invalid id", async () => {
    const badJson = new FormData();
    badJson.set("idea", "主题坏 JSON");
    badJson.set("durationSec", "10");
    badJson.set("format", "landscape");
    badJson.set("model", "fake/model-a");
    badJson.set("theme", "{not json");
    const res = await server.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: badJson }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("theme 不合法") });

    const badId = new FormData();
    badId.set("idea", "主题坏 id");
    badId.set("durationSec", "10");
    badId.set("format", "landscape");
    badId.set("model", "fake/model-a");
    badId.set("theme", JSON.stringify({ hue: { primary: "#fff" } })); // 缺 id
    const res2 = await server.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: badId }));
    expect(res2.status).toBe(400);
  });

  test("POST /api/jobs rejects invalid renderQuality", async () => {
    const form = new FormData();
    form.set("idea", "坏档位");
    form.set("durationSec", "10");
    form.set("format", "landscape");
    form.set("model", "fake/model-a");
    form.set("renderQuality", "ultra");
    const res = await server.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "renderQuality 不合法" });
  });

  test("GET /api/jobs lists jobs", async () => {
    const res = await server.fetch(new Request(`${base}/api/jobs`));
    const { jobs } = (await res.json()) as { jobs: unknown[] };
    // 前面用例成功 POST 创建了 4 个 job（2 个基础 + 2 个 theme/renderQuality；2 个非法输入用例不建 job）
    expect(jobs.length).toBe(4);
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

  test("channels: catalog lists presets without leaking keys; save/delete key flow", async () => {
    // 初始：无 key
    const res0 = await server.fetch(new Request(`${base}/api/channels`));
    const cat0 = (await res0.json()) as { presets: { id: string; name: string; hasKey: boolean }[] };
    expect(cat0.presets.map((p) => p.id)).toEqual(["fake", "custom"]);
    expect(cat0.presets.every((p) => !p.hasKey)).toBe(true);
    expect(JSON.stringify(cat0)).not.toContain("sk-");
    // 填 key
    const res = await server.fetch(new Request(`${base}/api/channels/fake`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-secret-123" }),
    }));
    expect(res.status).toBe(200);
    const cat = (await res.json()) as { presets: { id: string; hasKey: boolean }[] };
    expect(cat.presets.find((p) => p.id === "fake")?.hasKey).toBe(true);
    expect(JSON.stringify(cat)).not.toContain("sk-secret-123"); // key 绝不出现在响应里
    // 清 key
    const res2 = await server.fetch(new Request(`${base}/api/channels/fake`, { method: "DELETE" }));
    const cat2 = (await res2.json()) as { presets: { id: string; hasKey: boolean }[] };
    expect(cat2.presets.find((p) => p.id === "fake")?.hasKey).toBe(false);
  });

  test("channels: custom channel requires baseURL and models; test endpoint reports unconfigured", async () => {
    const bad = await server.fetch(new Request(`${base}/api/channels/custom`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-x" }), // 缺 baseURL/models
    }));
    expect(bad.status).toBe(400);
    const ok = await server.fetch(new Request(`${base}/api/channels/custom`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-x", baseURL: "https://example.com/v1", models: ["m1"] }),
    }));
    expect(ok.status).toBe(200);
    // 部分更新：只提交 models（模拟"获取模型→勾选→保存"），baseURL 回退已存值
    const partial = await server.fetch(new Request(`${base}/api/channels/custom`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-x", models: ["m1", "m2"] }),
    }));
    expect(partial.status).toBe(200);
    const cat = (await partial.json()) as { custom?: { models: string[]; baseURL: string }[] };
    expect(cat.custom?.[0].models).toEqual(["m1", "m2"]);
    expect(cat.custom?.[0].baseURL).toBe("https://example.com/v1");
    // 未配置渠道的 test → ok:false
    const test = await server.fetch(new Request(`${base}/api/channels/glm/test`));
    expect(await test.json()).toMatchObject({ ok: false });
  });

  test("channels: fetch models endpoint proxies OpenAI-compatible /models", async () => {
    // 本地假 /v1/models 服务
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v1/models") return new Response("not found", { status: 404 });
        if (req.headers.get("Authorization") !== "Bearer sk-stub") return new Response("unauthorized", { status: 401 });
        return Response.json({ data: [{ id: "stub-a" }, { id: "stub-b" }] });
      },
    });
    try {
      const stubBase = `http://localhost:${stub.port}/v1`;
      // 保存指向假服务的自定义渠道
      await server.fetch(new Request(`${base}/api/channels/custom`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-stub", baseURL: stubBase, models: ["stub-a"] }),
      }));
      const res = await server.fetch(new Request(`${base}/api/channels/custom/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ models: ["stub-a", "stub-b"] });
      // 错误 Key
      const bad = await server.fetch(new Request(`${base}/api/channels/custom/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-wrong" }),
      }));
      expect(bad.status).toBe(502);
      const body = (await bad.json()) as { error: string };
      expect(body.error).toContain("Key 无效");
    } finally {
      stub.stop(true);
    }
  });

  test("channels: PUT without apiKey updates models only (key preserved)", async () => {
    await server.fetch(new Request(`${base}/api/channels/fake`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-keep" }),
    }));
    const res = await server.fetch(new Request(`${base}/api/channels/fake`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["model-a", "model-b"] }),
    }));
    expect(res.status).toBe(200);
    const cat = (await res.json()) as { presets: { id: string; models: string[]; hasKey: boolean }[] };
    const fake = cat.presets.find((p) => p.id === "fake");
    expect(fake?.hasKey).toBe(true); // key 保留
    expect(fake?.models).toEqual(["model-a", "model-b"]); // 模型已更新
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

  test("GET /api/jobs/:id/files/* serves files inside the job dir", async () => {
    const { jobs } = (await (await server.fetch(new Request(`${base}/api/jobs`))).json()) as { jobs: { id: string }[] };
    const id = jobs[0].id;
    const proj = join(dir, "projects", id);
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "hello.txt"), "hello");
    const res = await server.fetch(new Request(`${base}/api/jobs/${id}/files/hello.txt`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  test("GET /api/jobs/:id/files/* rejects path traversal across job boundaries", async () => {
    const mk = async (idea: string) => {
      const form = new FormData();
      form.set("idea", idea);
      form.set("durationSec", "10");
      form.set("format", "landscape");
      const res = await server.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: form }));
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const idA = await mk("A");
    const idB = await mk("B");
    // job B 项目目录内放一个真实存在的文件
    const projB = join(dir, "projects", idB);
    mkdirSync(projB, { recursive: true });
    writeFileSync(join(projB, "secret.txt"), "top secret");
    // 穿越请求：<idA> 的 files/.. 指向 <idB> 的文件 → 必须 404
    const res = await server.fetch(new Request(`${base}/api/jobs/${idA}/files/../${idB}/secret.txt`));
    expect(res.status).toBe(404);
  });

  test("POST /api/jobs rejects non-numeric durationSec (NaN bypass)", async () => {
    const post = (durationSec: string) => {
      const form = new FormData();
      form.set("idea", "时长校验");
      form.set("durationSec", durationSec);
      form.set("format", "landscape");
      return server.fetch(new Request(`${base}/api/jobs`, { method: "POST", body: form }));
    };
    // Number("abc") = NaN：旧实现会同时骗过 <5 和 >120，导致非法任务入队
    const nan = await post("abc");
    expect(nan.status).toBe(400);
    expect(await nan.json()).toMatchObject({ error: "durationSec 需在 5-120 之间" });
    expect((await post("4")).status).toBe(400);
    expect((await post("121")).status).toBe(400);
    // 边界值合法
    expect((await post("5")).status).toBe(201);
    expect((await post("120")).status).toBe(201);
  });
});
