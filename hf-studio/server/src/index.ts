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
    baseProviders: providers,
    render: (projectDir: string) => new RenderService(projectDir),
    tts: new TtsService(),
  };
  return new PipelineEngine({ store, steps, services, projectRoot: PROJECTS_ROOT });
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
  Bun.serve({ hostname: "0.0.0.0", port, fetch: server.fetch });
  console.log(`[hf-studio] listening on http://localhost:${port}`);
}
