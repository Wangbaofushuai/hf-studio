#!/usr/bin/env bun
/**
 * HF-Studio 管理工具（vd）
 *
 * 终端菜单：1 启动项目（一条龙检测依赖，影响宿主机的操作先询问）、2 停止项目、
 * 0 退出。菜单常驻显示 RUN/STOP 状态与访问地址。
 *
 * 迁移性：脚本自定位（realpath 解析符号链接），项目根 = 脚本所在目录，
 * 零硬编码绝对路径——新服务器复制项目后 ln -s <项目>/vd.ts /usr/local/bin/vd 即可。
 */
import { spawn, execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";
import process from "node:process";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── 路径 ───────────────────────────

/** 项目根 = 脚本真实路径（解析符号链接）所在目录 */
export function resolveProjectRoot(argv1 = process.argv[1]): string {
  return dirname(realpathSync(argv1 ?? ""));
}

// ─────────────────────────── 公网地址 ───────────────────────────

/** 是否为私网/保留地址（10.x、172.16-31.x、192.168.x、100.64-127.x、169.254.x） */
export function isPrivateIp(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** 公网 IPv4（无则返回第一个非回环地址；都没有返回 null）。
 *  本机可能处于 NAT 环境（所有网卡都是私网 IP，如 10.8.0.8），公网地址只能从外部查询——
 *  故优先 `curl ifconfig.me`（带 5 分钟缓存，避免每次渲染菜单都查外网）。 */
let _cachedPublicIp: string | null | undefined;
export function publicIp(): string | null {
  if (_cachedPublicIp !== undefined) return _cachedPublicIp;
  let result: string | null = null;
  try {
    const out = execFileSync("curl", ["-s", "-m", "3", "ifconfig.me"], { encoding: "utf8", timeout: 5000 }).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(out)) result = out;
  } catch { /* fall through to local interfaces */ }
  if (!result) {
    const candidates: string[] = [];
    try {
      const out = execFileSync("hostname", ["-I"], { encoding: "utf8", timeout: 5000 });
      for (const ip of out.trim().split(/\s+/)) {
        if (ip.includes(".")) candidates.push(ip); // 只取 IPv4
      }
    } catch { /* fall through */ }
    if (candidates.length === 0) {
      for (const list of Object.values(networkInterfaces())) {
        for (const i of list ?? []) {
          if (i.family === "IPv4" && !i.internal) candidates.push(i.address);
        }
      }
    }
    result = candidates.find((ip) => !isPrivateIp(ip)) ?? candidates[0] ?? null;
  }
  _cachedPublicIp = result;
  return result;
}

// ─────────────────────────── 状态文件 ───────────────────────────

export interface VdState {
  backend: { pid: number; url: string };
  frontend: { pid: number; url: string };
  startedAt: string;
}

export function statePath(root: string): string {
  return join(root, ".tmp", "vd-state.json");
}

export function loadState(root: string): VdState | null {
  try {
    return JSON.parse(readFileSync(statePath(root), "utf8")) as VdState;
  } catch {
    return null;
  }
}

export function saveState(root: string, s: VdState): void {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(s, null, 2));
}

export function clearState(root: string): void {
  rmSync(statePath(root), { force: true });
}

// ─────────────────────────── 进程 ───────────────────────────

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 后台启动（独立进程组），stdout/stderr 写日志文件，返回 PID */
export function spawnDetached(
  root: string,
  cmd: string,
  args: string[],
  logFile: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): number {
  const logDir = join(root, ".tmp", "logs");
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, logFile), "a");
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? root,
    detached: true, // 成为进程组组长，停止时 kill(-pid) 可杀整组
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  child.unref();
  return child.pid;
}

/** 停止：SIGTERM 进程组 → 等待 → SIGKILL 兜底；清理状态文件 */
export async function stopProject(root: string, state: VdState | null): Promise<void> {
  if (!state) return;
  const pids = [state.backend.pid, state.frontend.pid];
  for (const p of pids) {
    try { process.kill(-p, "SIGTERM"); } catch { try { process.kill(p, "SIGTERM"); } catch { /* already dead */ } }
  }
  await sleep(1500);
  for (const p of pids) {
    if (isPidAlive(p)) {
      try { process.kill(-p, "SIGKILL"); } catch { try { process.kill(p, "SIGKILL"); } catch { /* ignore */ } }
    }
  }
  clearState(root);
}

/** 健康检查：url 返回 2xx 即通过，轮询到超时 */
export async function checkHealth(url: string, timeoutMs = 60_000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(intervalMs);
  }
  return false;
}

// ─────────────────────────── 依赖检测 ───────────────────────────

export interface CmdResult { code: number; stdout: string }
export interface CmdOpts { cwd?: string }
export type CmdRunner = (cmd: string, args: string[], opts?: CmdOpts) => Promise<CmdResult>;

export const defaultRunner: CmdRunner = async (cmd, args, opts) => {
  try {
    const { stdout } = await execFileP(cmd, args, { cwd: opts?.cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: String(stdout) };
  } catch (e: any) {
    return { code: typeof e.code === "number" ? e.code : 1, stdout: String(e.stdout ?? "") };
  }
};

export async function which(cmd: string, run: CmdRunner = defaultRunner): Promise<boolean> {
  return (await run("which", [cmd])).code === 0;
}

export interface DepCheck {
  name: string;
  ok: boolean;
  hostAffects: boolean;
  action: string;
  detail?: string;
}

function checkKey(root: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(root, "server", "config.json"), "utf8")) as { providers?: { apiKey?: string }[] };
    return (cfg.providers ?? []).some((p) => p.apiKey && p.apiKey !== "sk-REPLACE_ME");
  } catch {
    return false;
  }
}

export async function checkDeps(root: string, run: CmdRunner = defaultRunner): Promise<DepCheck[]> {
  const hasChrome = existsSync(join(process.env.HOME ?? "", ".cache", "hyperframes", "chrome"));
  return [
    {
      name: "bun", ok: await which("bun", run), hostAffects: true,
      action: "curl -fsSL https://bun.sh/install | bash（安装到 ~/.bun，宿主机变更）",
    },
    {
      name: "server 依赖", ok: existsSync(join(root, "server", "node_modules")), hostAffects: false,
      action: "cd server && bun install（项目内，自动）",
    },
    {
      name: "web 依赖", ok: existsSync(join(root, "web", "node_modules")), hostAffects: false,
      action: "cd web && bun install（项目内，自动）",
    },
    {
      name: "ffmpeg/ffprobe",
      ok: (await which("ffmpeg", run)) && (await which("ffprobe", run)), hostAffects: true,
      action: "apt-get install -y ffmpeg（系统级安装，需 root）",
    },
    {
      name: "Chrome Headless", ok: hasChrome, hostAffects: true,
      action: "hyperframes browser ensure（下载到 ~/.cache，用户级缓存）",
    },
    {
      name: "LLM key",
      ok: checkKey(root), hostAffects: false,
      action: "编辑 server/config.json 填入真实 apiKey，或在前端「自定义模型渠道」填写",
      detail: checkKey(root) ? undefined : "缺失或为占位 key（不阻塞启动，可在前端自定义渠道填）",
    },
  ];
}

// ─────────────────────────── 安装执行 ───────────────────────────

export async function installCheck(root: string, check: DepCheck, run: CmdRunner = defaultRunner): Promise<boolean> {
  switch (check.name) {
    case "server 依赖":
      return (await run("bun", ["install"], { cwd: join(root, "server") })).code === 0;
    case "web 依赖":
      return (await run("bun", ["install"], { cwd: join(root, "web") })).code === 0;
    case "ffmpeg/ffprobe":
      return (await run("apt-get", ["install", "-y", "ffmpeg"])).code === 0;
    case "Chrome Headless": {
      const bin = join(root, "server", "node_modules", ".bin", "hyperframes");
      return (await run(bin, ["browser", "ensure"], { cwd: join(root, "server") })).code === 0;
    }
    case "bun":
      return (await run("bash", ["-c", "curl -fsSL https://bun.sh/install | bash"])).code === 0;
    default:
      return true;
  }
}

// ─────────────────────────── 启动 / 停止流程 ───────────────────────────

export function apiPort(): number { return Number(process.env.HF_API_PORT ?? 8787); }
export function webPort(): number { return Number(process.env.HF_WEB_PORT ?? 5173); }

export async function portOccupied(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true; // 有响应 → 端口被占用
  } catch {
    return false; // 拒绝连接/超时 → 端口空闲
  }
}

/** 启动前后端，返回状态（含 PID 与地址） */
export async function startServers(root: string): Promise<VdState> {
  const api = apiPort();
  const web = webPort();
  const backendPid = spawnDetached(root, "bun", ["run", "dev:server"], "backend.log", {
    env: { PORT: String(api) },
  });
  const frontendPid = spawnDetached(root, "bun", ["run", "dev:web"], "frontend.log", {
    env: { HF_VITE_PORT: String(web) },
  });
  return {
    backend: { pid: backendPid, url: `http://localhost:${api}` },
    frontend: { pid: frontendPid, url: `http://localhost:${web}` },
    startedAt: new Date().toISOString(),
  };
}

// ─────────────────────────── 交互 ───────────────────────────

const G = "\x1b[32m", DIM = "\x1b[90m", RESET = "\x1b[0m", BOLD = "\x1b[1m";

/** 安全提问：stdin EOF/关闭后返回 null（管道输入、非交互场景不崩溃，调用方按退出处理） */
export async function ask(rl: import("node:readline/promises").Interface, q: string): Promise<string | null> {
  try {
    return await rl.question(q);
  } catch {
    return null;
  }
}

export async function promptYesNo(rl: import("node:readline/promises").Interface, question: string): Promise<boolean> {
  const answer = (await ask(rl, `${question} [y/N] `))?.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

export function renderMenu(running: boolean, state: VdState | null): void {
  const status = running ? `${G}RUN${RESET}` : `${DIM}STOP${RESET}`;
  const ip = publicIp();
  const wPort = webPort();
  const aPort = apiPort();
  console.log(`\n${BOLD}╭─ HF-Studio 管理工具 ───────────────────╮${RESET}`);
  console.log(`${BOLD}│${RESET} 状态: ${status}${running ? ` · 公网 ${G}http://${ip ?? "?"}:${wPort}${RESET}` : ""}`);
  if (running) {
    console.log(`${BOLD}│${RESET}       本地 ${state?.frontend.url} · 后端 ${state?.backend.url}`);
    if (ip) console.log(`${BOLD}│${RESET}       后端公网 http://${ip}:${aPort}`);
  }
  console.log(`${BOLD}│${RESET}  1. 启动项目`);
  console.log(`${BOLD}│${RESET}  2. 停止项目`);
  console.log(`${BOLD}│${RESET}  0. 退出`);
  console.log(`${BOLD}╰─────────────────────────────────────────╯${RESET}`);
}

/** 首次运行引导：vd 不在 PATH 时询问创建符号链接（宿主机变更） */
export async function ensureVdLink(rl: import("node:readline/promises").Interface): Promise<void> {
  const link = "/usr/local/bin/vd";
  if (existsSync(link)) return;
  const root = resolveProjectRoot();
  if (await promptYesNo(rl, `检测到 vd 尚未安装到 PATH。创建符号链接 ${link} → ${join(root, "vd.ts")}？（宿主机变更）`)) {
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("ln", ["-s", join(root, "vd.ts"), link]);
      console.log(`${G}✓ 已创建 ${link}，下次可直接输入 vd${RESET}`);
    } catch (e) {
      console.log(`创建失败：${e instanceof Error ? e.message : String(e)}（可手动执行 ln -s ${join(root, "vd.ts")} ${link}）`);
    }
  }
}

/** 启动一条龙：依赖检测 → 询问/安装 → 端口检查 → 启动 → 健康检查 → 打印地址 */
export async function startFlow(root: string, rl: import("node:readline/promises").Interface): Promise<void> {
  const existing = loadState(root);
  if (existing && isPidAlive(existing.backend.pid) && isPidAlive(existing.frontend.pid)) {
    console.log(`项目已在运行（前端 ${existing.frontend.url}）。如需重启请先选择 2 停止。`);
    return;
  }

  console.log("\n── 依赖检测 ──");
  const deps = await checkDeps(root);
  for (const d of deps) {
    if (d.ok) continue;
    if (d.hostAffects) {
      const yes = await promptYesNo(rl, `${d.name} 缺失：${d.action}。是否安装？`);
      if (!yes) {
        console.log(`跳过 ${d.name}（可能影响后续功能：${d.detail ?? "渲染/运行可能不可用"}）`);
        continue;
      }
    }
    const ok = await installCheck(root, d);
    console.log(`${ok ? "✓" : "✗"} ${d.name}${ok ? " 就绪" : " 安装失败"}`);
  }

  // LLM 渠道 key 提示（不阻塞启动）
  try {
    const { hasAnyKey, loadChannelKeys } = await import("./server/src/channels");
    if (!hasAnyKey(loadChannelKeys(join(root, "data", "channels.json")))) {
      const ip = publicIp();
      console.log(`${DIM}提示：尚未配置任何模型渠道 Key。请打开 ${ip ? `http://${ip}:${webPort()}/channels` : "网页「模型渠道」页"} 填写（预设 DeepSeek/GLM/Qwen/OpenAI/Kimi）${RESET}`);
    }
  } catch { /* vd 独立运行时忽略渠道模块加载失败 */ }

  // 端口冲突检查（停止后立即启动时旧进程可能仍在退出，重试 ~5s 等端口释放）
  for (const [name, url] of [["后端", `http://localhost:${apiPort()}`], ["前端", `http://localhost:${webPort()}`]] as const) {
    let free = false;
    for (let i = 0; i < 10; i++) {
      if (!(await portOccupied(url))) { free = true; break; }
      await sleep(500);
    }
    if (!free) {
      console.log(`端口冲突：${name} ${url} 已被占用，中止启动（可用 HF_API_PORT/HF_WEB_PORT 换端口）。`);
      return;
    }
  }

  console.log("\n── 启动服务 ──");
  const state = await startServers(root);
  const [apiOk, webOk] = await Promise.all([
    checkHealth(`${state.backend.url}/api/health`, 60_000),
    checkHealth(state.frontend.url, 60_000),
  ]);
  if (!apiOk || !webOk) {
    console.log(`启动超时：api=${apiOk} web=${webOk}（日志见 .tmp/logs/）`);
    await stopProject(root, state);
    return;
  }
  saveState(root, state);
  const ip = publicIp();
  console.log(`\n${G}✓ 项目已启动${RESET}`);
  console.log(`  前端界面: ${BOLD}${state.frontend.url}${RESET}`);
  console.log(`  后端 API: ${BOLD}${state.backend.url}${RESET}`);
  if (ip) console.log(`  公网访问: ${BOLD}http://${ip}:${webPort()}${RESET}（若打不开请检查云安全组是否放行 ${webPort()}/${apiPort()} 端口）`);
  await ask(rl, "按回车返回菜单…");
}

/** 停止流程 */
export async function stopFlow(root: string): Promise<void> {
  const state = loadState(root);
  if (!state) {
    console.log("项目当前未运行。");
    return;
  }
  await stopProject(root, state);
  console.log("✓ 已停止项目。");
}

// ─────────────────────────── 主循环 ───────────────────────────

async function main(): Promise<void> {
  const root = resolveProjectRoot();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await ensureVdLink(rl);
  for (;;) {
    const state = loadState(root);
    const running = !!state && isPidAlive(state.backend.pid) && isPidAlive(state.frontend.pid);
    if (!running && state) clearState(root); // 进程已死 → 清理陈旧状态
    renderMenu(running, loadState(root));
    const answer = (await ask(rl, "请选择: "))?.trim() ?? "";
    if (answer === "1") await startFlow(root, rl);
    else if (answer === "2") await stopFlow(root);
    else if (answer === "0" || answer === "") break; // EOF/空输入 → 退出
    else console.log("无效输入，请输入 1 / 2 / 0。");
  }
  rl.close();
  console.log("再见。");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
