import { Hono } from "hono";
import { mkdirSync, readdirSync, statSync, createReadStream } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import type { JobStore } from "../db/store";
import type { PipelineEngine } from "../pipeline/engine";
import type { AppConfig } from "../config";
import type { TtsService } from "../tts/service";
import type { StepId, JobConfig, LlmProvider } from "../types";
import { LlmGateway } from "../llm/gateway";
import { buildProviders, channelCatalog, deleteChannelKey, fetchChannelModels, loadChannelKeys, saveChannelKey, type ChannelKeys } from "../channels";

const ALLOWED_IMAGE = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const ALLOWED_AUDIO = ["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-wav"];
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** 渠道存储注入点（测试可传临时文件实现；缺省用真实 data/channels.json） */
export interface ChannelsStore {
  load: () => ChannelKeys;
  save: (id: string, v: { apiKey: string; baseURL?: string; models?: string[] }) => void;
  remove: (id: string) => void;
}

const defaultChannelsStore: ChannelsStore = {
  load: loadChannelKeys,
  save: saveChannelKey.bind(null, undefined),
  remove: deleteChannelKey.bind(null, undefined),
};

/** 解析前端 BYOK 渠道 JSON；非法输入返回空数组（由调用方决定是否报错） */
function parseProviders(raw: string): LlmProvider[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as LlmProvider[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p) => p && typeof p.id === "string" && typeof p.baseURL === "string" && typeof p.apiKey === "string" && Array.isArray(p.models) && p.models.length > 0);
  } catch {
    return [];
  }
}

export function createServer(opts: {
  store: JobStore; engine: PipelineEngine; config: AppConfig; projectsRoot: string; tts: TtsService;
  channels?: ChannelsStore;
}): { fetch: (req: Request) => Promise<Response> } {
  const app = new Hono();
  const chStore = opts.channels ?? defaultChannelsStore;

  app.post("/api/jobs", async (c) => {
    const form = await c.req.formData();
    const idea = String(form.get("idea") ?? "");
    const durationSec = Number(form.get("durationSec") ?? 15);
    const format = String(form.get("format") ?? "landscape") as JobConfig["format"];
    const voiceover = String(form.get("voiceover")) === "true";
    const voice = String(form.get("voice") ?? opts.config.tts.defaultVoice);
    const language = String(form.get("language") ?? opts.config.tts.defaultLanguage);
    const model = String(form.get("model") ?? "").trim() || opts.config.defaults.model;
    // 前端 BYOK 自定义渠道（可选）：JSON 数组 [{id, baseURL, apiKey, models[]}]
    const providers = parseProviders(String(form.get("providers") ?? ""));

    if (!idea.trim()) return c.json({ error: "idea 不能为空" }, 400);
    if (!model) return c.json({ error: "请选择模型渠道（模型未配置）" }, 400);
    // Number("abc") = NaN 会同时骗过 < 5 与 > 120 两个比较，必须显式拒绝非有限数
    if (!Number.isFinite(durationSec) || durationSec < 5 || durationSec > 120) {
      return c.json({ error: "durationSec 需在 5-120 之间" }, 400);
    }
    if (!["landscape", "portrait", "square"].includes(format)) return c.json({ error: "format 不合法" }, 400);

    const images: string[] = [];
    let audio: string | null = null;
    const jobId = opts.store.createJob({
      idea, durationSec, format, voiceover, voice, language,
      models: { default: model },
      materials: { images, audio },
      ...(providers.length > 0 ? { providers } : {}),
    });

    const assetDir = join(opts.projectsRoot, jobId, "assets");
    mkdirSync(assetDir, { recursive: true });
    for (const entry of form.getAll("files")) {
      if (!(entry instanceof File)) continue;
      if (entry.size > MAX_FILE_BYTES) { opts.store.updateJob(jobId, { status: "failed", error: `文件超限: ${entry.name}` }); return c.json({ error: `文件超限: ${entry.name}` }, 400); }
      const type = entry.type;
      const isImg = ALLOWED_IMAGE.includes(type);
      const isAudio = ALLOWED_AUDIO.includes(type);
      if (!isImg && !isAudio) { opts.store.updateJob(jobId, { status: "failed", error: `不支持的文件类型: ${entry.name}` }); return c.json({ error: `不支持的文件类型: ${entry.name} (${type})` }, 400); }
      const safe = entry.name.replace(/[^\w.\-]/g, "_");
      await Bun.write(join(assetDir, safe), entry);
      if (isImg) images.push(safe);
      else audio = safe;
    }
    opts.store.updateJob(jobId, { config: { idea, durationSec, format, voiceover, voice, language, models: { default: model }, materials: { images, audio }, ...(providers.length > 0 ? { providers } : {}) } });
    opts.engine.enqueue(jobId);
    return c.json({ id: jobId }, 201);
  });

  app.get("/api/jobs", (c) => {
    const jobs = opts.store.listJobs(50);
    return c.json({ jobs });
  });

  app.get("/api/jobs/:id", (c) => {
    const job = opts.store.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const steps = opts.store.getStepOutputs(job.id);
    const proj = join(opts.projectsRoot, job.id);
    const artifacts = listArtifacts(proj);
    return c.json({ job, steps, artifacts });
  });

  app.post("/api/jobs/:id/rerun", async (c) => {
    const job = opts.store.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    // 排队/运行中重跑会与在途 runJob 并发写 step_runs（已删的行不会再跑，最终 completed 且 step 缺失）
    if (job.status === "queued" || job.status === "running") return c.json({ error: "任务正在运行中，请稍后重试" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { step?: number; model?: string };
    const step = body.step as StepId | undefined;
    if (step === undefined || step < 0 || step > 6) return c.json({ error: "step 需在 0-6" }, 400);
    if (body.model) {
      opts.store.updateJob(job.id, { config: { ...job.config, models: { ...job.config.models, default: body.model } } });
    }
    opts.engine.rerunFrom(job.id, step); // engine 内部会先 store.rerunFrom 再入队
    return c.json({ ok: true }, 202);
  });

  app.get("/api/jobs/:id/events", (c) => {
    const jobId = c.req.param("id");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        // 流被关闭（cancel/abort）后 enqueue 会抛错，且该错误会经由 engine.emit 冒泡打断
        // 整条引擎处理链，故统一走 safe() 守卫：closed 后静默丢弃
        const safe = (chunk: Uint8Array) => {
          if (closed) return;
          try { controller.enqueue(chunk); } catch { closed = true; }
        };
        const send = (e: unknown) => safe(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        const listener = (e: unknown) => {
          const ev = e as { jobId?: string };
          if (!ev.jobId || ev.jobId === jobId) send(e);
        };
        opts.engine.onEvent(listener);
        const heartbeat = setInterval(() => safe(enc.encode(`: ping\n\n`)), 15000);
        // 断开时同时移除引擎监听器，避免长期占用监听数组
        const cleanup = () => { closed = true; clearInterval(heartbeat); opts.engine.offEvent(listener); };
        c.req.raw.signal.addEventListener("abort", cleanup);
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  });

  app.get("/api/jobs/:id/files/*", (c) => {
    const jobId = c.req.param("id");
    const rest = c.req.path.split(`/api/jobs/${jobId}/files/`)[1] ?? "";
    const base = join(opts.projectsRoot, jobId);
    const target = normalize(join(base, rest));
    // 路径钳制：target 必须是 base 之内的普通文件。不能用字符串前缀判断——
    // normalize 后 "../" 可能已跨出 base，或兄弟目录名以 base 为前缀（前缀碰撞）。
    const rel = relative(base, target);
    if (rel.startsWith("..") || isAbsolute(rel) || !statSync(target, { throwIfNoEntry: false })?.isFile()) {
      return c.json({ error: "not found" }, 404);
    }
    return new Response(Bun.file(target));
  });

  app.get("/api/models", (c) => {
    const providers = buildProviders(opts.config.presetChannels, chStore.load());
    return c.json({
      providers: providers.map((p) => ({ id: p.id, models: p.models })),
      default: opts.config.defaults.model,
    });
  });

  // ── 模型渠道管理（key 存服务端 data/channels.json，接口绝不回传 key） ──

  app.get("/api/channels", (c) => c.json(channelCatalog(opts.config.presetChannels, chStore.load())));

  app.put("/api/channels/:id", async (c) => {
    const id = c.req.param("id");
    const preset = opts.config.presetChannels.find((p) => p.id === id);
    if (!preset) return c.json({ error: "未知渠道" }, 404);
    const keys = chStore.load();
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string; baseURL?: string; models?: string[] };
    // Key 可缺省（仅更新模型时）；但至少要有一个可用 key
    const finalKey = body.apiKey ?? keys[id]?.apiKey;
    if (!finalKey || typeof finalKey !== "string") return c.json({ error: "apiKey 不能为空" }, 400);
    const models = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string" && m.length > 0) : undefined;
    if (id === "custom") {
      if (!body.baseURL || !models || models.length === 0) {
        return c.json({ error: "自定义渠道需要 baseURL 与至少一个模型" }, 400);
      }
      chStore.save(id, { apiKey: finalKey, baseURL: body.baseURL, models });
    } else {
      chStore.save(id, { apiKey: finalKey, ...(models ? { models } : {}) });
    }
    return c.json(channelCatalog(opts.config.presetChannels, chStore.load()));
  });

  app.delete("/api/channels/:id", (c) => {
    const id = c.req.param("id");
    const preset = opts.config.presetChannels.find((p) => p.id === id);
    if (!preset) return c.json({ error: "未知渠道" }, 404);
    chStore.remove(id);
    return c.json(channelCatalog(opts.config.presetChannels, chStore.load()));
  });

  app.get("/api/channels/:id/test", async (c) => {
    const id = c.req.param("id");
    const providers = buildProviders(opts.config.presetChannels, chStore.load());
    const provider = providers.find((p) => p.id === id);
    if (!provider) return c.json({ ok: false, error: "渠道未配置 Key" });
    const started = Date.now();
    try {
      const gw = new LlmGateway([provider]);
      const r = await gw.chat({
        model: `${id}/${provider.models[0]}`,
        messages: [{ role: "user", content: "回复 OK 两个字" }],
        maxTokens: 10,
        timeoutMs: 30_000,
      });
      return c.json({ ok: true, latencyMs: Date.now() - started, content: r.content.slice(0, 20) });
    } catch (e) {
      return c.json({ ok: false, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 获取渠道模型列表（用刚填或已存的 Key 调 OpenAI 兼容 /models 接口）
  app.post("/api/channels/:id/models", async (c) => {
    const id = c.req.param("id");
    const preset = opts.config.presetChannels.find((p) => p.id === id);
    if (!preset) return c.json({ error: "未知渠道" }, 404);
    const keys = chStore.load();
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string };
    const apiKey = body.apiKey ?? keys[id]?.apiKey;
    if (!apiKey) return c.json({ error: "请先填写 Key" }, 400);
    const baseURL = id === "custom" ? keys.custom?.baseURL : preset.baseURL;
    if (!baseURL) return c.json({ error: "自定义渠道缺少 baseURL" }, 400);
    try {
      const models = await fetchChannelModels(baseURL, apiKey);
      return c.json({ models });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.get("/api/voices", async (c) => {
    const lang = c.req.query("lang");
    const voices = await opts.tts.listVoices(lang);
    return c.json({ voices });
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  // 返回 { fetch } 对象以匹配接口约定（调用方 server.fetch(...)）；不能直接返回裸函数。
  // Hono 对同步 handler 会同步返回 Response，Promise.resolve 包装后接口恒为 Promise
  return { fetch: (req: Request) => Promise.resolve(app.fetch(req)) };
}

function listArtifacts(proj: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (!statSync(p).isFile()) { walk(p, `${prefix}${name}/`); continue; }
      out.push(`${prefix}${name}`);
    }
  };
  if (statSync(proj, { throwIfNoEntry: false })?.isDirectory()) walk(proj, "");
  return out;
}
