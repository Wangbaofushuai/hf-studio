import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config";
import type { AppConfig } from "./config";
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

export function buildEngine(store: JobStore = createStore(), config: AppConfig = loadConfig()): PipelineEngine {
  const services = {
    llm: new LlmGateway(config.providers),
    judge: new Judge(new LlmGateway(config.providers), config.defaults.judgeModel, config.defaults.judgeThreshold),
    baseProviders: config.providers,
    render: (projectDir: string) => new RenderService(projectDir),
    tts: new TtsService(),
  };
  return new PipelineEngine({ store, steps, services, projectRoot: PROJECTS_ROOT });
}

if (import.meta.main) {
  mkdirSync(PROJECTS_ROOT, { recursive: true });
  const config = loadConfig();
  const store = createStore();
  const engine = buildEngine(store, config);
  const tts = new TtsService();
  const server = createServer({ store, engine, config, projectsRoot: PROJECTS_ROOT, tts });
  const port = Number(process.env.PORT ?? 8787);
  Bun.serve({ port, fetch: server.fetch });
  console.log(`[hf-studio] listening on http://localhost:${port}`);
}
