import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { StepContext, StepFn, StepResult } from "../../types";
import { stripCodeFences, ensureCjkFontStack, stripClipAttrs, normalizeBeatAnimations, ensureRootWrapper } from "../../util/clean-output";
import { RESOLUTIONS } from "../../render/resolutions";
import { probeMedia } from "../../util/ffprobe";
import { jimengClipRel, jimengDurationSec } from "./jimeng-video";

const FIX_SYSTEM = readFileSync(new URL("../../prompts/fix-beat.txt", import.meta.url), "utf8");

// 真实 CLI（hyperframes check --json）的 finding 字段是 sourceFile（code/severity/time/
// selector/sourceFile/message/fixHint），无 `file` 字段；测试桩可能用 `file`，两者都兼容。
interface CheckFinding { file?: string; sourceFile?: string; message?: string; rule?: string; code?: string }

export const step5Validate: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  // —— AI 直出（jimeng）分支 ——
  if (ctx.config.mode === "jimeng") {
    const jm = prev[4]?.data.jimeng as { items?: Record<string, { clipPath?: string }>; clipPath?: string } | undefined;
    const timed = (prev[4]?.data.beats as { id?: string; index: number; startSec: number; endSec: number }[] | undefined) ?? [];

    // Phase 2：逐片段校验（存在/视频流/至少可用；窗口不足部分由拼接阶段补帧）
    if (jm?.items && Object.keys(jm.items).length > 0 && timed.length > 0) {
      const errors: string[] = [];
      const artifacts: string[] = [];
      for (const t of timed) {
        const rel = t.id ? jm.items[t.id]?.clipPath : undefined;
        if (!rel) { errors.push(`${t.id ?? `beat-${t.index}`} 缺少片段记录`); continue; }
        const abs = join(ctx.projectDir, rel);
        if (!existsSync(abs)) { errors.push(`${rel} 不存在`); continue; }
        const probe = await probeMedia(abs);
        const windowSec = Math.max(1, t.endSec - t.startSec);
        const floor = Math.min(windowSec, 4) * 0.9;
        if (!probe.hasVideo || probe.durationSec < floor) {
          errors.push(`${t.id ?? `beat-${t.index}`} 片段无效：hasVideo=${probe.hasVideo}, ${probe.durationSec.toFixed(1)}s < 下限 ${floor.toFixed(1)}s`);
          continue;
        }
        artifacts.push(rel);
      }
      if (errors.length > 0) {
        return { status: "gate_failed", artifacts, data: {}, log: `即梦片段校验失败（${errors.length} 项）`, gateErrors: errors };
      }
      return {
        status: "passed",
        artifacts: [...artifacts, "jimeng/state.json"],
        data: { clips: artifacts.length },
        log: `即梦片段校验通过：${artifacts.length} 个`,
      };
    }

    // Phase 1 兼容：单条片段时长偏差 ≤30%
    const rel = jimengClipRel(ctx.projectDir);
    const abs = join(ctx.projectDir, rel);
    if (!existsSync(abs)) {
      return { status: "gate_failed", artifacts: [], data: {}, log: `即梦片段缺失：${rel}`, gateErrors: [`${rel} 不存在`] };
    }
    const probe = await probeMedia(abs);
    if (!probe.hasVideo || probe.durationSec <= 0) {
      return {
        status: "gate_failed",
        artifacts: [rel],
        data: { durationSec: probe.durationSec, hasVideo: probe.hasVideo },
        log: `即梦片段无效：hasVideo=${probe.hasVideo}, duration=${probe.durationSec.toFixed(1)}s`,
        gateErrors: ["片段无有效视频流"],
      };
    }
    const expected = jimengDurationSec(ctx.config);
    const dev = Math.abs(probe.durationSec - expected) / expected;
    if (dev > 0.3) {
      return {
        status: "gate_failed",
        artifacts: [rel],
        data: { durationSec: probe.durationSec },
        log: `即梦片段时长偏差 ${(dev * 100).toFixed(0)}%`,
        gateErrors: [`时长 ${probe.durationSec.toFixed(1)}s vs 预期 ${expected}s，偏差 ${(dev * 100).toFixed(0)}% > 30%`],
      };
    }
    return {
      status: "passed",
      artifacts: [rel, "jimeng/state.json"],
      data: { durationSec: probe.durationSec, hasVideo: true },
      log: `即梦片段校验通过：${rel}（${probe.durationSec.toFixed(1)}s）`,
    };
  }

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
      // 真实 CLI 的 sourceFile 是绝对路径：join(projectDir, 绝对路径) 会拼出错误嵌套路径
      // → statSync 失败 → 修复被静默跳过 → check 永不恢复 → 死循环重试。绝对路径直接用。
      const abs = isAbsolute(file) ? file : join(ctx.projectDir, file);
      // index.html 是 root-html.ts 确定性生成的宿主文件（root/audio/slot 的 data-start/duration
      // 已正确生成）。LLM 修复 + stripClipAttrs 会剥掉宿主定时属性 → check 报
      // media_missing_data_start / root_composition_missing_data_start 死循环失败。
      // 宿主问题只应由 root-html.ts 保证；这里只修复 compositions/*.html 子合成。
      if (abs.endsWith("index.html")) continue;
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
        // 修复同样要求严格遵守 composition 契约：但与 step4 同理，flash 快速模型的 thinking:enabled
        // 不稳定（挂起/空输出），统一 thinking:disabled + max_tokens 上限，靠 fix-beat.txt 与 lint 兜底
        thinking: "disabled",
        reasoningEffort: ctx.config.quality === "fast" ? "low" : ctx.config.quality === "high" ? "high" : "medium",
        maxTokens: 16_000,
      });
      const beatId = abs.split("/").pop()?.replace(/\.html$/, "") ?? "beat";
      // 与 step4 同链：修复输出同样必须强制根元素/字体/无 clip（否则同一确定性错误反复 3 次重试，纯耗 LLM）
      const { w, h } = RESOLUTIONS[ctx.config.format];
      // 动画契约修正（2026-09-28）：确定性规范化 beat 动画（去掉 immediateRender:false、可见起点 fromTo 改 to()），避免"首帧全显/提前显形"穿帮
  writeFileSync(abs, ensureRootWrapper(normalizeBeatAnimations(stripClipAttrs(ensureCjkFontStack(stripCodeFences(fixed)))), { id: beatId, w, h }));
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
