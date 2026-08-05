import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PresetChannel } from "./channels";

export interface AppConfig {
  presetChannels: PresetChannel[];
  defaults: { model: string; judgeModel: string; judgeThreshold: number };
  tts: { defaultVoice: string; defaultLanguage: string };
}

const DEFAULTS: AppConfig = {
  presetChannels: [],
  defaults: { model: "", judgeModel: "", judgeThreshold: 7 },
  tts: { defaultVoice: "zh-CN-XiaoxiaoNeural", defaultLanguage: "zh-CN" },
};

export function loadConfig(configPath?: string): AppConfig {
  const path = configPath ?? resolve(import.meta.dir, "../config.json");
  if (!existsSync(path)) return DEFAULTS;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
  return {
    presetChannels: raw.presetChannels ?? DEFAULTS.presetChannels,
    defaults: { ...DEFAULTS.defaults, ...raw.defaults },
    tts: { ...DEFAULTS.tts, ...raw.tts },
  };
}
