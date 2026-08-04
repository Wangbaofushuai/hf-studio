// server/src/render/service.ts —— hyperframes CLI 封装 + 项目脚手架生成（Task 2）
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JobConfig } from "../types";
import { RESOLUTIONS } from "./resolutions";
export { RESOLUTIONS };

const execFileP = promisify(execFile);
export interface CliResult { stdout: string; stderr: string; code: number }
export interface LintFinding { rule: string; message: string; severity: "error" | "warning" | "info"; file?: string; code?: string }

const BLANK_META = (name: string, createdAt: string) =>
  JSON.stringify({ id: name, name, createdAt }, null, 2);

const BLANK_HYPERFRAMES_JSON = `{
  "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
  "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
  "paths": { "blocks": "compositions", "components": "compositions/components", "assets": "assets" },
  "media": { "autoProxy": true }
}`;

const BLANK_PACKAGE_JSON = (name: string) =>
  JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        dev: "npx --yes hyperframes preview",
        check: "npx --yes hyperframes check",
        render: "npx --yes hyperframes render",
      },
    },
    null,
    2,
  );

// 与 `hyperframes init --example blank` 生成的 index.html 一致（去掉占位符），
// 按 RESOLUTIONS[format] 注入画布宽高；data-duration=10 覆盖测试的 snapshot 时间点。
const BLANK_INDEX_HTML = (w: number, h: number) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${w}, height=${h}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        width: ${w}px;
        height: ${h}px;
        overflow: hidden;
        background: #000;
      }
      body {
        font-family: "Inter", sans-serif;
      }
      code,
      pre,
      .monospace {
        font-family: "JetBrains Mono", monospace;
      }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="10"
      data-width="${w}"
      data-height="${h}"
    >
      <!--
        Add your clips here. Example:
        <div id="title" class="clip" data-start="0" data-duration="5" data-track-index="1"
             style="font-size: 64px; color: #fff; padding: 40px">
          Hello World
        </div>
      -->
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      // Example: tl.from("#title", { opacity: 0, y: -50, duration: 1 }, 0);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;

export class RenderService {
  private cliBin: string;
  constructor(private projectDir: string, cliBin?: string) {
    this.cliBin = cliBin ?? resolve(import.meta.dir, "../../node_modules/.bin/hyperframes");
  }

  async exec(args: string[], opts: { timeoutMs?: number } = {}): Promise<CliResult> {
    const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    try {
      const { stdout, stderr } = await execFileP(this.cliBin, args, {
        cwd: this.projectDir,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, HYPERFRAMES_NO_UPDATE_CHECK: "1" },
      });
      return { stdout, stderr, code: 0 };
    } catch (e: any) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
    }
  }

  async doctor(): Promise<{ ok: boolean; items: { name: string; ok: boolean; detail: string }[] }> {
    const r = await this.exec(["doctor", "--json"]);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
    };
    // CLI 真实输出字段是 checks（不是 items），映射为 items 以满足接口约定
    return { ok: parsed.ok, items: parsed.checks ?? [] };
  }

  async initProject(name: string, format: JobConfig["format"]): Promise<void> {
    const { w, h } = RESOLUTIONS[format];
    mkdirSync(join(this.projectDir, "compositions"), { recursive: true });
    mkdirSync(join(this.projectDir, "assets"), { recursive: true });
    // index.html 采用"存在则跳过"（Task 13 携带指针）：生产链路在 step0 前调用
    // initProject，若这里无条件覆盖，rerunFrom 恢复时会拿空白模板覆盖 step4 生成的
    // 真实 index.html。全新目录下 index.html 不存在，仍写入空白模板，行为与之前一致。
    if (!existsSync(join(this.projectDir, "index.html"))) {
      writeFileSync(join(this.projectDir, "index.html"), BLANK_INDEX_HTML(w, h));
    }
    writeFileSync(join(this.projectDir, "meta.json"), BLANK_META(name, new Date().toISOString()));
    writeFileSync(join(this.projectDir, "hyperframes.json"), BLANK_HYPERFRAMES_JSON);
    writeFileSync(join(this.projectDir, "package.json"), BLANK_PACKAGE_JSON(name));
  }

  async lint(): Promise<{ ok: boolean; errorCount: number; findings: LintFinding[] }> {
    const r = await this.exec(["lint", "--json"]);
    const parsed = JSON.parse(r.stdout) as {
      ok?: boolean;
      errorCount: number;
      findings: { rule?: string; code?: string; message: string; severity: string; file?: string }[];
    };
    return {
      // 真实 CLI 在"无合成"等场景会报 ok:false 且 errorCount:0，因此 ok 必须透传；
      // 旧版 CLI 无 ok 字段时按 errorCount===0 兜底
      ok: parsed.ok ?? (parsed.errorCount === 0),
      errorCount: parsed.errorCount,
      findings: (parsed.findings ?? []).map((f) => ({
        // 真实 CLI 的 finding 用 `code`（如 missing_or_empty_sub_composition），无 `rule` 字段
        rule: f.rule ?? "",
        code: f.code,
        message: f.message,
        severity: f.severity as LintFinding["severity"],
        file: f.file,
      })),
    };
  }

  async check(): Promise<{ ok: boolean; summary: Record<string, unknown> }> {
    const r = await this.exec(["check", "--json"], { timeoutMs: 10 * 60 * 1000 });
    const parsed = JSON.parse(r.stdout) as { ok: boolean };
    return { ok: parsed.ok, summary: parsed as Record<string, unknown> };
  }

  async snapshot(at: number[]): Promise<string[]> {
    // --no-end：默认会追加一帧片尾帧，导致 PNG 数量多 1；测试期望只取 --at 指定时间点
    // 运行前清空 snapshots/，保证返回值只反映本次捕获（CLI 失败时也不会返回上次残留的旧 PNG）
    const snapDir = join(this.projectDir, "snapshots");
    rmSync(snapDir, { recursive: true, force: true });
    const r = await this.exec(["snapshot", ".", "--at", at.join(","), "--no-end"], { timeoutMs: 10 * 60 * 1000 });
    if (r.code !== 0) throw new Error(`snapshot failed (code ${r.code}): ${r.stderr || r.stdout}`);
    if (!existsSync(snapDir)) throw new Error(`snapshot failed: ${r.stderr || r.stdout}`);
    return readdirSync(snapDir)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .map((f) => join(snapDir, f));
  }

  async render(outputPath: string, quality: "draft" | "standard" | "high" = "standard"): Promise<void> {
    const r = await this.exec(
      ["render", "--output", outputPath, "--quality", quality, "--workers", "2"],
      { timeoutMs: 30 * 60 * 1000 },
    );
    if (r.code !== 0 || !existsSync(outputPath)) {
      throw new Error(`render failed (code ${r.code}): ${r.stderr || r.stdout}`);
    }
  }
}
