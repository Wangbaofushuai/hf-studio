import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProviders, channelCatalog, deleteChannelKey, hasAnyKey, loadChannelKeys,
  migrateLegacyConfig, saveChannelKey, type PresetChannel,
} from "../src/channels";

const presets: PresetChannel[] = [
  { id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", models: ["deepseek-chat"], thinking: "disabled" },
  { id: "glm", name: "智谱 GLM", baseURL: "https://open.bigmodel.cn/api/paas/v4", models: ["glm-4.5"] },
  { id: "custom", name: "自定义渠道", baseURL: "", models: [] },
];

describe("channels", () => {
  test("buildProviders merges presets with keys; unconfigured presets omitted", () => {
    const providers = buildProviders(presets, { deepseek: { apiKey: "sk-d" }, custom: { apiKey: "sk-c", baseURL: "https://x.com/v1", models: ["m1"] } });
    expect(providers.map((p) => p.id).sort()).toEqual(["custom", "deepseek"]);
    expect(providers.find((p) => p.id === "deepseek")).toMatchObject({ baseURL: "https://api.deepseek.com/v1", apiKey: "sk-d", thinking: "disabled" });
    expect(providers.find((p) => p.id === "custom")).toMatchObject({ baseURL: "https://x.com/v1", models: ["m1"] });
  });

  test("placeholder keys and missing custom definition are excluded", () => {
    const providers = buildProviders(presets, { deepseek: { apiKey: "sk-REPLACE_ME" }, custom: { apiKey: "sk-c" } });
    expect(providers).toEqual([]);
  });

  test("channelCatalog never includes apiKey values", () => {
    const cat = channelCatalog(presets, { deepseek: { apiKey: "sk-top-secret" } });
    expect(JSON.stringify(cat)).not.toContain("sk-top-secret");
    expect(cat.presets.find((p) => p.id === "deepseek")?.hasKey).toBe(true);
    expect(cat.presets.find((p) => p.id === "glm")?.hasKey).toBe(false);
    expect(cat.custom).toEqual([]);
  });

  test("save/load/delete round-trip on temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-ch-"));
    const path = join(dir, "channels.json");
    saveChannelKey(path, "glm", { apiKey: "sk-g" });
    expect(loadChannelKeys(path)).toEqual({ glm: { apiKey: "sk-g" } });
    expect(hasAnyKey(loadChannelKeys(path))).toBe(true);
    deleteChannelKey(path, "glm");
    expect(loadChannelKeys(path)).toEqual({});
    expect(hasAnyKey({})).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("migrateLegacyConfig moves keys to channels.json and rewrites config (idempotent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-mig-"));
    const cfgPath = join(dir, "config.json");
    const chPath = join(dir, "channels.json");
    writeFileSync(cfgPath, JSON.stringify({
      providers: [{ id: "deepseek", baseURL: "https://api.deepseek.com/v1", apiKey: "sk-legacy", models: ["deepseek-chat"] }],
      defaults: { model: "deepseek/deepseek-chat" },
    }));
    migrateLegacyConfig(cfgPath, chPath);
    // key 迁出
    expect(loadChannelKeys(chPath)).toEqual({ deepseek: { apiKey: "sk-legacy" } });
    // config 重写为 presetChannels 且不含 key
    const cfg = JSON.parse(require("node:fs").readFileSync(cfgPath, "utf8")) as { presetChannels: PresetChannel[]; providers?: unknown };
    expect(cfg.providers).toBeUndefined();
    expect(cfg.presetChannels[0]).toMatchObject({ id: "deepseek", name: "DeepSeek", models: ["deepseek-chat"] });
    expect(JSON.stringify(cfg)).not.toContain("sk-legacy");
    // 幂等：再跑一次不重复迁移
    const before = JSON.stringify(loadChannelKeys(chPath));
    migrateLegacyConfig(cfgPath, chPath);
    expect(JSON.stringify(loadChannelKeys(chPath))).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });
});
