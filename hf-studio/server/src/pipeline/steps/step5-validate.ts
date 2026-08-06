import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult } from "../../types";
import { stripCodeFences, ensureCjkFontStack, stripClipAttrs, ensureRootWrapper } from "../../util/clean-output";
import { RESOLUTIONS } from "../../render/resolutions";

const FIX_SYSTEM = readFileSync(new URL("../../prompts/fix-beat.txt", import.meta.url), "utf8");

// 真实 CLI（hyperframes check --json）的 finding 字段是 sourceFile（code/severity/time/
// selector/sourceFile/message/fixHint），无 `file` 字段；测试桩可能用 `file`，两者都兼容。
interface CheckFinding { file?: string; sourceFile?: string; message?: string; rule?: string; code?: string }

export const step5Validate: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  // 引擎注入 `_model`（每步可覆盖）；直接调用（测试）时回退到 config 默认模型
  const model = (ctx as unknown as { _model?: string })._model ?? ctx.config.models.default;
  // prev 按 step 编号索引（step1~4 同约定）：step4 build 的 data.beats 含 startSec/endSec
  const beats = (prev[4]?.data.beats as { id: string; startSec: number; endSec: number }[] | undefined) ?? [];

  // 脚手架兜底（Task 12 注记）：生产链路此前未调用 RenderService.initProject，
  // meta.json/hyperframes.json/package.json 可能缺失，`hyperframes check` 会失败。
  // 仅在 meta.json 缺失时补齐脚手架；测试桩 render 对象没有 initProject 方法时跳过。
  if (!existsSync(join(ctx.projectDir, "meta.json")) && "initProject" in ctx.render) {
    await ctx.render.initProject(ctx.jobId, ctx.config.format);
  }

  let check = await ctx.render.check();
  let repairRounds = 0;

  while (!check.ok && repairRounds < 2) {
    repairRounds++;
    const findings = extractFindings(check.summary);
    // 按文件分组（真实 CLI 用 sourceFile；兼容测试桩的 file）
    const byFile = new Map<string, CheckFinding[]>();
    for (const f of findings) {
      const file = f.sourceFile ?? f.file;
      if (!file) continue; // 无文件信息的 finding 无法定位修复目标，跳过
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(f);
    }
    for (const [file, list] of byFile) {
      const abs = join(ctx.projectDir, file);
      // sourceFile 可能指向目录（如 "compositions"）或已不存在的文件：只修复真实存在的普通文件
      if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
      const content = readFileSync(abs, "utf8");
      const { content: fixed } = await ctx.llm.chat({
        model,
        messages: [
          { role: "system", content: FIX_SYSTEM },
          { role: "user", content: `findings:\n${JSON.stringify(list, null, 2)}\n\n当前文件内容：\n${content}` },
        ],
        temperature: 0.3,
        seed: 55,
        // 修复同样要求严格遵守 composition 契约：强制思考 + 中等档（与 step4 同理）
        thinking: "enabled",
        reasoningEffort: "medium",
      });
      const beatId = abs.split("/").pop()?.replace(/\.html$/, "") ?? "beat";
      // 与 step4 同链：修复输出同样必须强制根元素/字体/无 clip（否则同一确定性错误反复 3 次重试，纯耗 LLM）
      const { w, h } = RESOLUTIONS[ctx.config.format];
      writeFileSync(abs, ensureRootWrapper(stripClipAttrs(ensureCjkFontStack(stripCodeFences(fixed))), { id: beatId, w, h }));
    }
    check = await ctx.render.check();
  }

  if (!check.ok) {
    return {
      status: "gate_failed",
      artifacts: [],
      data: { check: check.summary },
      log: `check 未通过（修复 ${repairRounds} 轮后仍失败）`,
      gateErrors: [`hyperframes check 失败：${JSON.stringify(check.summary).slice(0, 2000)}`],
    };
  }

  // 快照：每个 beat 中点
  const midpoints = beats.map((b) => Number(((b.startSec + b.endSec) / 2).toFixed(2)));
  const snapshots = await ctx.render.snapshot(midpoints);
  const relSnaps = snapshots.map((p) => `snapshots/${p.split("/").pop()}`);
  writeFileSync(join(ctx.projectDir, "check.json"), JSON.stringify(check.summary, null, 2));
  return {
    status: "passed",
    artifacts: ["check.json", ...relSnaps],
    data: { snapshots: relSnaps, check: check.summary },
    log: `验证通过：check 0 错误，${relSnaps.length} 张快照`,
  };
};

function extractFindings(summary: Record<string, unknown>): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const key of ["lint", "runtime", "layout", "motion", "contrast"]) {
    const section = summary[key];
    if (section && typeof section === "object") {
      const findings = (section as { findings?: CheckFinding[] }).findings;
      if (Array.isArray(findings)) out.push(...findings);
    }
  }
  return out;
}
