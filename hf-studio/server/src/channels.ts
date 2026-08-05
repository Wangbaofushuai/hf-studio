import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LlmProvider } from "./llm/gateway";

/** 预设渠道定义（config.json，不含 key） */
export interface PresetChannel {
  id: string;
  name: string;
  baseURL: string;
  models: string[];
  thinking?: "enabled" | "disabled";
  temperature?: number;
}

/** 用户渠道 key 存储（data/channels.json，gitignored）；custom 渠道含完整定义 */
export interface ChannelKeys {
  [id: string]: { apiKey: string; baseURL?: string; models?: string[] };
}

export function channelsPath(root?: string): string {
  return root ? join(root, "data", "channels.json") : resolve(import.meta.dir, "../../data/channels.json");
}

export function loadChannelKeys(path?: string): ChannelKeys {
  const p = path ?? channelsPath();
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ChannelKeys;
  } catch {
    return {};
  }
}

function writeChannelKeys(path: string, keys: ChannelKeys): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keys, null, 2) + "\n");
}

export function saveChannelKey(path: string | undefined, id: string, v: { apiKey: string; baseURL?: string; models?: string[] }): void {
  const p = path ?? channelsPath();
  const keys = loadChannelKeys(p);
  keys[id] = v;
  writeChannelKeys(p, keys);
}

export function deleteChannelKey(path: string | undefined, id: string): void {
  const p = path ?? channelsPath();
  const keys = loadChannelKeys(p);
  delete keys[id];
  writeChannelKeys(p, keys);
}

export function hasAnyKey(keys: ChannelKeys): boolean {
  return Object.values(keys).some((v) => v.apiKey && v.apiKey !== "sk-REPLACE_ME");
}

/** 合并预设渠道定义与用户 key → 引擎可用的 providers（自定义渠道取 channels.json 完整定义） */
export function buildProviders(presets: PresetChannel[], keys: ChannelKeys): LlmProvider[] {
  const out: LlmProvider[] = [];
  for (const preset of presets) {
    if (preset.id === "custom") continue; // 自定义渠道由下方专用分支处理（其定义在 channels.json）
    const k = keys[preset.id];
    if (!k?.apiKey || k.apiKey === "sk-REPLACE_ME") continue; // 未填 key 的预设不产出 provider
    out.push({
      id: preset.id,
      baseURL: preset.baseURL,
      apiKey: k.apiKey,
      models: preset.models,
      ...(preset.thinking ? { thinking: preset.thinking } : {}),
      ...(preset.temperature !== undefined ? { temperature: preset.temperature } : {}),
    });
  }
  const custom = keys.custom;
  if (custom?.apiKey && custom.baseURL && (custom.models?.length ?? 0) > 0) {
    out.push({
      id: "custom",
      baseURL: custom.baseURL,
      apiKey: custom.apiKey,
      models: custom.models ?? [],
    });
  }
  return out;
}

/** 渠道目录（含 key 状态，供前端；绝不回传 key 本身） */
export function channelCatalog(presets: PresetChannel[], keys: ChannelKeys) {
  const presetsView = presets.map((p) => ({
    id: p.id,
    name: p.name,
    baseURL: p.baseURL,
    models: p.models,
    thinking: p.thinking,
    hasKey: !!(keys[p.id]?.apiKey && keys[p.id]!.apiKey !== "sk-REPLACE_ME"),
  }));
  const custom = keys.custom;
  const customView = custom?.baseURL
    ? [{ id: "custom", name: "自定义渠道", baseURL: custom.baseURL, models: custom.models ?? [], hasKey: !!custom.apiKey }]
    : [];
  return { presets: presetsView, custom: customView };
}

/** 迁移旧结构：config.json 若含 `providers`（带 apiKey），把 key 迁入 channels.json，config 重写为新结构。幂等。 */
export function migrateLegacyConfig(configPath?: string, channelsFilePath?: string): void {
  const path = configPath ?? resolve(import.meta.dir, "../config.json");
  if (!existsSync(path)) return;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { providers?: LlmProvider[]; presetChannels?: PresetChannel[] };
  const legacyProviders = raw.providers;
  if (!Array.isArray(legacyProviders) || legacyProviders.length === 0) return; // 无旧数据
  if (raw.presetChannels) return; // 已是新结构

  const keysPath = channelsFilePath ?? channelsPath();
  const keys = loadChannelKeys(keysPath);
  for (const p of legacyProviders) {
    if (p.apiKey && p.apiKey !== "sk-REPLACE_ME") {
      keys[p.id] = { apiKey: p.apiKey };
    }
  }
  writeChannelKeys(keysPath, keys);

  // 重写 config.json：presetChannels 保留 providers 的定义（去掉 key）
  const presets: PresetChannel[] = legacyProviders.map((p) => ({
    id: p.id,
    name: p.id === "deepseek" ? "DeepSeek" : p.id,
    baseURL: p.baseURL,
    models: p.models,
    ...(p.thinking ? { thinking: p.thinking } : {}),
  }));
  const rest = { ...raw } as Record<string, unknown>;
  delete rest.providers;
  const out = { presetChannels: presets, ...rest };
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
}
