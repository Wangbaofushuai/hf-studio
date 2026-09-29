// server/src/jimeng/cli.ts —— 即梦画布 CLI（dreamina-canvas）薄适配层
// 约定：全部调用带 --format json --non-interactive；进程环境注入 HOME / DREAMINA_CANVAS_STATE_DIR
// 实现零宿主隔离（见 spec 附录 8.1）；错误只在结构化字段/退出码上分支。
import { resolve } from "node:path";
import type { JimengError } from "./errors";

export interface CliResult<T = unknown> {
  code: number;
  ok: boolean;
  data?: T;
  error?: JimengError;
  requestId?: string;
  raw: string;
}

/** 可注入的进程执行器（测试用假实现；默认 Bun.spawn） */
export type CliRunner = (
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface JimengCliOptions {
  bin?: string;
  homeDir?: string;
  stateDir?: string;
  runner?: CliRunner;
}

/** 项目内二进制路径：<hf-studio>/.tools/dreamina-canvas/bin/dreamina-canvas（HF_JIMENG_BIN 可覆盖） */
export function defaultJimengBin(): string {
  return resolve(import.meta.dir, "../../../.tools/dreamina-canvas/bin/dreamina-canvas");
}

async function spawnRunner(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin, ...args], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { code: 127, stdout: "", stderr: `无法启动即梦 CLI（${bin}）：${e instanceof Error ? e.message : String(e)}` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* 已退出 */ }
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (timedOut) return { code: 124, stdout, stderr: `${stderr}\n[timeout ${timeoutMs}ms]` };
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export class JimengCli {
  readonly bin: string;
  readonly homeDir: string;
  readonly stateDir: string;
  private runner: CliRunner;

  constructor(opts: JimengCliOptions = {}) {
    this.bin = opts.bin ?? process.env.HF_JIMENG_BIN ?? defaultJimengBin();
    const projectRoot = resolve(import.meta.dir, "../../..");
    this.homeDir = opts.homeDir ?? resolve(projectRoot, "data/jimeng/home");
    this.stateDir = opts.stateDir ?? resolve(projectRoot, "data/jimeng/state");
    this.runner = opts.runner ?? spawnRunner;
  }

  async call<T = unknown>(args: string[], opts: { timeoutMs?: number } = {}): Promise<CliResult<T>> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const fullArgs = ["--format", "json", "--non-interactive", ...args];
    const env = { HOME: this.homeDir, DREAMINA_CANVAS_STATE_DIR: this.stateDir };
    const { code, stdout, stderr } = await this.runner(this.bin, fullArgs, env, timeoutMs);
    return parseResult<T>(code, stdout, stderr);
  }
}

export function parseResult<T>(code: number, stdout: string, stderr: string): CliResult<T> {
  const raw = (stdout.trim() || stderr.trim()).trim();
  try {
    const env = JSON.parse(raw) as {
      ok?: boolean;
      data?: T;
      error?: JimengError;
      meta?: { requestId?: string };
      // 退出码 10 的 envelope：creditConfirmation / partialData 与 error 同级（官方示例）
      creditConfirmation?: JimengError["creditConfirmation"];
      partialData?: JimengError["partialData"];
    };
    if (typeof env === "object" && env !== null) {
      const error = env.error ? { ...env.error } : undefined;
      if (error) {
        if (!error.creditConfirmation && env.creditConfirmation) error.creditConfirmation = env.creditConfirmation;
        if (!error.partialData && env.partialData) error.partialData = env.partialData;
      }
      return {
        code,
        ok: env.ok === true,
        data: env.data,
        error,
        requestId: env.meta?.requestId,
        raw,
      };
    }
  } catch {
    /* 非 JSON：走兜底 */
  }
  return {
    code,
    ok: code === 0,
    error:
      code === 0
        ? undefined
        : {
            code: "cli.unparsed_output",
            class: "internal",
            message: raw.slice(0, 500) || `即梦 CLI 退出码 ${code}`,
            retryable: false,
            requiredAction: "none",
          },
    raw,
  };
}
