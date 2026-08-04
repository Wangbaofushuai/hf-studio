import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LlmProvider } from "./llm/gateway";

export interface AppConfig {
  providers: LlmProvider[];
  defaults: { model: string; judgeModel: string; judgeThreshold: number };
  tts: { defaultVoice: string; defaultLanguage: string };
}

const DEFAULTS: AppConfig = {
  providers: [],
  defaults: { model: "", judgeModel: "", judgeThreshold: 7 },
  tts: { defaultVoice: "zh-CN-XiaoxiaoNeural", defaultLanguage: "zh-CN" },
};

export function loadConfig(configPath?: string): AppConfig {
  const path = configPath ?? resolve(import.meta.dir, "../config.json");
  if (!existsSync(path)) return DEFAULTS;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
  return {
    providers: raw.providers ?? DEFAULTS.providers,
    defaults: { ...DEFAULTS.defaults, ...raw.defaults },
    tts: { ...DEFAULTS.tts, ...raw.tts },
  };
}
