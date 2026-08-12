import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config";
import type { AppConfig } from "./config";
import { buildProviders, loadChannelKeys, migrateLegacyConfig } from "./channels";
import { JobStore } from "./db/store";
import { LlmGateway } from "./llm/gateway";
import { Judge } from "./judge/judge";
import { RenderService } from "./render/service";
import { TtsService } from "./tts/service";
import { PipelineEngine } from "./pipeline/engine";
import { steps } from "./pipeline/steps";
import { createServer } from "./api/server";

export const DATA_ROOT = resolve(import.meta.dir, "../../data");
const PROJECTS_ROOT = resolve(DATA_ROOT, "projects");

/** 创建并初始化全局 JobStore（init/recover 幂等，可安全重复调用） */
function createStore(): JobStore {
  const store = new JobStore(resolve(DATA_ROOT, "jobs.db"));
  store.init();
  store.recover();
  return store;
}

/** 合并预设渠道 + 用户 key → 引擎 providers（未填 key 的渠道不产出） */
export function mergedProviders(config: AppConfig) {
  return buildProviders(config.presetChannels, loadChannelKeys());
}

export function buildEngine(store: JobStore = createStore(), config: AppConfig = loadConfig()): PipelineEngine {
  const providers = mergedProviders(config);
  const services = {
    llm: new LlmGateway(providers),
    judge: new Judge(new LlmGateway(providers), config.defaults.judgeModel, config.defaults.judgeThreshold),
    judgeModel: config.defaults.judgeModel,
    baseProviders: providers,
    render: (projectDir: string) => new RenderService(projectDir),
    tts: new TtsService(),
  };
  // 并发上限：HF_STUDIO_CONCURRENCY（默认 2，钳制 ≥1）；4 核 7.8G 下 2 个渲染并行是安全值
  const maxConcurrency = Math.max(1, Number(process.env.HF_STUDIO_CONCURRENCY ?? 2) || 2);
  return new PipelineEngine({ store, steps, services, projectRoot: PROJECTS_ROOT, maxConcurrency });
}

if (import.meta.main) {
  mkdirSync(PROJECTS_ROOT, { recursive: true });
  // 旧结构 config.json（providers 含 key）→ 迁移为 presetChannels + data/channels.json
  migrateLegacyConfig();
  const config = loadConfig();
  const store = createStore();
  const engine = buildEngine(store, config);
  const tts = new TtsService();
  const server = createServer({ store, engine, config, projectsRoot: PROJECTS_ROOT, tts });
  const port = Number(process.env.PORT ?? 8787);
  // 公网部署：显式绑 0.0.0.0（默认即全网卡，写明以明确意图）
  // idleTimeout: 0 —— 禁用请求级空闲超时。Bun 默认 10s 会掐断 SSE 长连接（/api/jobs/:id/events），
  // 导致前端 EventSource 反复断开、进度不刷新。SSE 需要长连接，其余 API 请求都在 handler 内快速返回，
  // 引擎的慢 LLM 调用在后台事件循环执行，不经由本 server 请求通道，故禁用空闲超时是安全的。
  Bun.serve({ hostname: "0.0.0.0", port, idleTimeout: 0, fetch: server.fetch });
  console.log(`[hf-studio] listening on http://localhost:${port}`);
}
