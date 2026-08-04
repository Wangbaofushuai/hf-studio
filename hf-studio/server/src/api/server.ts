import { Hono } from "hono";
import { mkdirSync, readdirSync, statSync, createReadStream } from "node:fs";
import { join, normalize, relative } from "node:path";
import type { JobStore } from "../db/store";
import type { PipelineEngine } from "../pipeline/engine";
import type { AppConfig } from "../config";
import type { TtsService } from "../tts/service";
import type { StepId, JobConfig, LlmProvider } from "../types";

const ALLOWED_IMAGE = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const ALLOWED_AUDIO = ["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-wav"];
const MAX_FILE_BYTES = 50 * 1024 * 1024;

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
}): { fetch: (req: Request) => Promise<Response> } {
  const app = new Hono();

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
    if (durationSec < 5 || durationSec > 120) {
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
    if (!target.startsWith(base) || !statSync(target, { throwIfNoEntry: false })?.isFile()) {
      return c.json({ error: "not found" }, 404);
    }
    return new Response(Bun.file(target));
  });

  app.get("/api/models", (c) => c.json({
    providers: opts.config.providers.map((p) => ({ id: p.id, models: p.models })),
    default: opts.config.defaults.model,
  }));

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
