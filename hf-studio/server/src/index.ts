import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config";
import { JobStore } from "./db/store";
import { LlmGateway } from "./llm/gateway";
import { Judge } from "./judge/judge";
import { RenderService } from "./render/service";
import { TtsService } from "./tts/service";
import { PipelineEngine } from "./pipeline/engine";
import { steps } from "./pipeline/steps";

export const DATA_ROOT = resolve(import.meta.dir, "../../data");
const PROJECTS_ROOT = resolve(DATA_ROOT, "projects");

export function buildEngine(): PipelineEngine {
  const config = loadConfig();
  const store = new JobStore(resolve(DATA_ROOT, "jobs.db"));
  store.init();
  store.recover();
  const services = {
    llm: new LlmGateway(config.providers),
    judge: new Judge(new LlmGateway(config.providers), config.defaults.judgeModel, config.defaults.judgeThreshold),
    baseProviders: config.providers,
    render: (projectDir: string) => new RenderService(projectDir),
    tts: new TtsService(),
  };
  const engine = new PipelineEngine({ store, steps, services, projectRoot: PROJECTS_ROOT });
  return engine;
}

if (import.meta.main) {
  mkdirSync(PROJECTS_ROOT, { recursive: true });
  const engine = buildEngine();
  console.log("[hf-studio] engine ready (HTTP server lands in Task 14)");
  void engine;
}
