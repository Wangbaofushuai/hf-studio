import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VdState, loadState, saveState, clearState, statePath,
  isPidAlive, checkHealth, spawnDetached, stopProject,
  checkDeps, which, resolveProjectRoot, isPrivateIp,
} from "../vd";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "vd-test-"));
}

describe("vd core", () => {
  test("state round-trips through .tmp/vd-state.json", () => {
    const root = tmpRoot();
    const s: VdState = {
      backend: { pid: 123, url: "http://localhost:8787" },
      frontend: { pid: 456, url: "http://localhost:5173" },
      startedAt: new Date().toISOString(),
    };
    saveState(root, s);
    expect(loadState(root)).toEqual(s);
    expect(existsSync(statePath(root))).toBe(true);
    clearState(root);
    expect(loadState(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  test("isPidAlive detects real and dead pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(99999999)).toBe(false);
  });

  test("checkHealth succeeds against a live port and fails against a dead one", async () => {
    // 用一个临时 HTTP 服务验证
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const url = `http://localhost:${server.port}`;
    expect(await checkHealth(url, 5000)).toBe(true);
    await server.stop(true);
    expect(await checkHealth(`http://localhost:${server.port}`, 2000, 100)).toBe(false);
  }, 15000);

  test("spawnDetached + stopProject lifecycle (real bun process)", async () => {
    const root = tmpRoot();
    // 起一个长驻进程：bun 打印后 sleep
    const pid = spawnDetached(root, "bun", ["-e", "setInterval(()=>{},1000)"], "lifecycle.log");
    expect(isPidAlive(pid)).toBe(true);
    const state: VdState = { backend: { pid, url: "x" }, frontend: { pid, url: "x" }, startedAt: "" };
    await stopProject(root, state);
    expect(isPidAlive(pid)).toBe(false);
    expect(loadState(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  }, 20000);

  test("checkDeps reports host-affecting gaps via injected runner", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "server", "node_modules"), { recursive: true }); // 模拟已安装
    writeFileSync(join(root, "server", "config.json"), JSON.stringify({ providers: [{ apiKey: "sk-REAL" }] }));
    // 只有 bun 存在；ffmpeg/ffprobe 缺失
    const run = async (cmd: string, args: string[]) =>
      ({ code: cmd === "which" && args[0] === "bun" ? 0 : 1, stdout: "" });
    const deps = await checkDeps(root, run as never);
    const byName = Object.fromEntries(deps.map((d) => [d.name, d]));
    expect(byName["bun"].ok).toBe(true);
    expect(byName["server 依赖"].ok).toBe(true);
    // ffmpeg 缺失 → 标记需宿主询问
    expect(byName["ffmpeg/ffprobe"].ok).toBe(false);
    expect(byName["ffmpeg/ffprobe"].hostAffects).toBe(true);
    expect(byName["web 依赖"].ok).toBe(false);
    expect(byName["web 依赖"].hostAffects).toBe(false);
    expect(byName["LLM key"].ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("placeholder LLM key is flagged", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "config.json"), JSON.stringify({ providers: [{ apiKey: "sk-REPLACE_ME" }] }));
    const run = async () => ({ code: 1, stdout: "" });
    const deps = await checkDeps(root, run as never);
    expect(deps.find((d) => d.name === "LLM key")?.ok).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("isPrivateIp classifies public and private ranges", () => {
    expect(isPrivateIp("10.8.0.8")).toBe(true);
    expect(isPrivateIp("172.17.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("100.64.1.1")).toBe(true);
    expect(isPrivateIp("169.254.1.1")).toBe(true);
    expect(isPrivateIp("43.133.250.224")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });
});
