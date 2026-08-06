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

/** 用户渠道 key 存储（data/channels.json，gitignored）；自定义渠道含完整定义与可选名称 */
export interface ChannelKeys {
  [id: string]: { apiKey: string; baseURL?: string; models?: string[]; name?: string };
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

export function saveChannelKey(path: string | undefined, id: string, v: { apiKey: string; baseURL?: string; models?: string[]; name?: string }): void {
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

/** 从 OpenAI 兼容渠道拉取模型列表（GET /models）；Key 无效/接口异常时抛错 */
export async function fetchChannelModels(baseURL: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Key 无效（401/403），请检查后重试");
  if (!res.ok) throw new Error(`获取模型失败（HTTP ${res.status}）`);
  const json = (await res.json()) as { data?: { id?: string }[] };
  const models = (json.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
  if (models.length === 0) throw new Error("接口未返回模型列表（响应结构不是 OpenAI 兼容格式）");
  return models;
}

/** 合并预设渠道定义与用户 key → 引擎可用的 providers（自定义渠道取 channels.json 完整定义） */
export function buildProviders(presets: PresetChannel[], keys: ChannelKeys): LlmProvider[] {
  const out: LlmProvider[] = [];
  for (const preset of presets) {
    if (preset.id === "custom") continue; // 自定义渠道模板不产出 provider（真实定义在 channels.json）
    const k = keys[preset.id];
    if (!k?.apiKey || k.apiKey === "sk-REPLACE_ME") continue; // 未填 key 的预设不产出 provider
    out.push({
      id: preset.id,
      baseURL: preset.baseURL,
      apiKey: k.apiKey,
      // 用户自选的模型列表优先于预设（"获取模型"后保存的自选）
      models: k.models?.length ? k.models : preset.models,
      ...(preset.thinking ? { thinking: preset.thinking } : {}),
      ...(preset.temperature !== undefined ? { temperature: preset.temperature } : {}),
    });
  }
  // 多自定义渠道：所有非预设 id 且具备 baseURL/key/models 的条目都产出 provider。
  // 预设 id 集合排除 "custom" 模板——keys.custom 是用户真实的自定义渠道，必须照常产出
  const presetIds = new Set(presets.filter((p) => p.id !== "custom").map((p) => p.id));
  for (const [id, k] of Object.entries(keys)) {
    if (presetIds.has(id)) continue;
    if (!k?.apiKey || k.apiKey === "sk-REPLACE_ME" || !k.baseURL || !(k.models?.length ?? 0)) continue;
    out.push({ id, baseURL: k.baseURL, apiKey: k.apiKey, models: k.models ?? [] });
  }
  return out;
}

/** 渠道目录（含 key 状态，供前端；绝不回传 key 本身） */
export function channelCatalog(presets: PresetChannel[], keys: ChannelKeys) {
  const presetIds = new Set(presets.filter((p) => p.id !== "custom").map((p) => p.id));
  // 预设目录不包含 "custom" 模板（模板只是占位，真实自定义渠道在下方 customs 列表）
  const presetsView = presets.filter((p) => p.id !== "custom").map((p) => {
    const k = keys[p.id];
    return {
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      // 生效模型 = 用户自选 ?? 预设
      models: k?.models?.length ? k.models : p.models,
      thinking: p.thinking,
      hasKey: !!(k?.apiKey && k.apiKey !== "sk-REPLACE_ME"),
    };
  });
  const customs = Object.entries(keys)
    .filter(([id, k]) => !presetIds.has(id) && !!k.baseURL)
    .map(([id, k]) => ({
      id,
      name: k.name ?? "自定义渠道",
      baseURL: k.baseURL as string,
      models: k.models ?? [],
      hasKey: !!k.apiKey,
    }));
  return { presets: presetsView, custom: customs };
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
