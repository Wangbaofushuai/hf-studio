import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VdState, loadState, saveState, clearState, statePath,
  isPidAlive, checkHealth, spawnDetached, stopProject,
  checkDeps, which, resolveProjectRoot, isPrivateIp, installCheck,
  findGitRoot, missingChromeRuntimeLibs,
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

  test("findGitRoot climbs to the nearest .git directory", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "repo", "sub", "deep"), { recursive: true });
    mkdirSync(join(root, "repo", ".git"));
    expect(findGitRoot(join(root, "repo", "sub", "deep"))).toBe(join(root, "repo"));
    expect(findGitRoot(join(root, "repo", "sub"))).toBe(join(root, "repo"));
    expect(findGitRoot(join(root, "repo"))).toBe(join(root, "repo"));
    expect(findGitRoot(join(root, "elsewhere"))).toBeNull();
    rmSync(root, { recursive: true, force: true });
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

  test("checkDeps flags missing CJK fonts as host-affecting (empty fc-list)", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "server", "node_modules"), { recursive: true });
    writeFileSync(join(root, "server", "config.json"), JSON.stringify({ providers: [{ apiKey: "sk-REAL" }] }));
    // fc-list 存在但无中文字体（stdout 为空）
    const run = async (cmd: string, args: string[]) =>
      ({ code: cmd === "fc-list" ? 0 : 1, stdout: "" });
    const deps = await checkDeps(root, run as never);
    const cjk = deps.find((d) => d.name === "中文字体（CJK）");
    expect(cjk?.ok).toBe(false);
    expect(cjk?.hostAffects).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("checkDeps passes when fc-list lists a CJK font", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "server", "node_modules"), { recursive: true });
    const run = async (cmd: string, args: string[]) =>
      ({ code: cmd === "fc-list" ? 0 : 1, stdout: cmd === "fc-list" ? "/usr/share/fonts/opentype/noto/NotoSansCJK.ttc: Noto Sans CJK SC" : "" });
    const deps = await checkDeps(root, run as never);
    expect(deps.find((d) => d.name === "中文字体（CJK）")?.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("installCheck installs fonts-noto-cjk via apt for CJK fonts", async () => {
    const root = tmpRoot();
    let called = "";
    const run = async (cmd: string, args: string[]) => { called = `${cmd} ${args.join(" ")}`; return { code: 0, stdout: "" }; };
    const dep = { name: "中文字体（CJK）", ok: false, hostAffects: true, action: "apt" };
    const ok = await installCheck(root, dep, run as never);
    expect(ok).toBe(true);
    expect(called).toBe("apt-get install -y fonts-noto-cjk");
    rmSync(root, { recursive: true, force: true });
  });

  test("missingChromeRuntimeLibs reports all libs when ldconfig is empty", async () => {
    const run = async () => ({ code: 1, stdout: "" });
    const missing = await missingChromeRuntimeLibs(run as never);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain("libnss3.so");
    expect(missing).toContain("libXcomposite.so.1");
  });

  test("missingChromeRuntimeLibs only reports absent libs", async () => {
    const libs = ["libnss3.so", "libnspr4.so", "libXcomposite.so.1"];
    const stdout = libs.map((l) => `\t${l} (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/${l}`).join("\n");
    const run = async () => ({ code: 0, stdout });
    const missing = await missingChromeRuntimeLibs(run as never);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).not.toContain("libnss3.so");
  });

  test("checkDeps flags missing Chrome runtime libs as host-affecting", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "server", "node_modules"), { recursive: true });
    writeFileSync(join(root, "server", "config.json"), JSON.stringify({ providers: [{ apiKey: "sk-REAL" }] }));
    const run = async (cmd: string, args: string[]) =>
      ({ code: cmd === "ldconfig" ? 0 : 1, stdout: cmd === "ldconfig" ? "\tlibnss3.so (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libnss3.so" : "" });
    const deps = await checkDeps(root, run as never);
    const chromeLibs = deps.find((d) => d.name === "Chrome 运行库");
    expect(chromeLibs?.ok).toBe(false);
    expect(chromeLibs?.hostAffects).toBe(true);
    expect(chromeLibs?.detail).toContain("缺失");
    rmSync(root, { recursive: true, force: true });
  });

  test("checkDeps passes when all Chrome runtime libs are present", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "server", "node_modules"), { recursive: true });
    writeFileSync(join(root, "server", "config.json"), JSON.stringify({ providers: [{ apiKey: "sk-REAL" }] }));
    const libs = ["libnss3.so", "libnspr4.so", "libatk-1.0.so.0", "libatk-bridge-2.0.so.0", "libcups.so.2", "libdrm.so.2", "libxkbcommon.so.0", "libatspi.so.0", "libXcomposite.so.1", "libXdamage.so.1", "libXfixes.so.3", "libXrandr.so.2", "libgbm.so.1", "libxcb.so.1", "libxkbcommon-x11.so.0", "libasound.so.2"];
    const stdout = libs.map((l) => `\t${l} (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/${l}`).join("\n");
    const run = async (cmd: string, args: string[]) =>
      ({ code: cmd === "ldconfig" ? 0 : 1, stdout: cmd === "ldconfig" ? stdout : "" });
    const deps = await checkDeps(root, run as never);
    expect(deps.find((d) => d.name === "Chrome 运行库")?.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("installCheck installs Chrome runtime packages via apt", async () => {
    const root = tmpRoot();
    let called = "";
    const run = async (cmd: string, args: string[]) => { called = `${cmd} ${args.join(" ")}`; return { code: 0, stdout: "" }; };
    const dep = { name: "Chrome 运行库", ok: false, hostAffects: true, action: "apt" };
    const ok = await installCheck(root, dep, run as never);
    expect(ok).toBe(true);
    expect(called).toContain("apt-get install -y");
    expect(called).toContain("libnss3");
    expect(called).toContain("libxkbcommon-x11-0");
    rmSync(root, { recursive: true, force: true });
  });

  test("checkDeps flags missing server/config.json (preset channels)", async () => {
    const root = tmpRoot();
    const run = async () => ({ code: 1, stdout: "" });
    const deps = await checkDeps(root, run as never);
    const cfg = deps.find((d) => d.name === "渠道配置");
    expect(cfg?.ok).toBe(false);
    expect(cfg?.hostAffects).toBe(false); // 项目内自动修复，不询问
    rmSync(root, { recursive: true, force: true });
  });

  test("installCheck creates config.json from config.example.json when missing", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "config.example.json"), JSON.stringify({ presetChannels: [{ id: "deepseek" }] }));
    const dep = { name: "渠道配置", ok: false, hostAffects: false, action: "重建" };
    const ok = await installCheck(root, dep);
    expect(ok).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "server", "config.json"), "utf8")).presetChannels[0].id).toBe("deepseek");
    rmSync(root, { recursive: true, force: true });
  });
});
