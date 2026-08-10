import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult, Beat } from "../../types";
import type { LintFinding } from "../../render/service";
import { generateRootHtml } from "../root-html";
import { RESOLUTIONS } from "../../render/resolutions";
import { stripCodeFences, ensureCjkFontStack, stripClipAttrs, ensureRootWrapper } from "../../util/clean-output";

const SYSTEM = readFileSync(new URL("../../prompts/build-beat.txt", import.meta.url), "utf8");

/** 真实 CLI 对"引用尚未写入的合成文件"产出 missing_or_empty_sub_composition finding
 *  （message 含 "does not exist"，字段是 `code`，无 `rule`）。逐个写 beat 的 lint 门里
 *  这类错误必然出现（index.html 在写 beat 前已引用全部 beat），必须过滤；
 *  全部 beat 写完后最终完整 lint 才把它们当作真实失败。 */
function isMissingFileFinding(f: LintFinding): boolean {
  return f.code === "missing_or_empty_sub_composition"
    || f.rule === "missing_or_empty_sub_composition"
    || /does not exist/i.test(f.message ?? "");
}

export const step4Build: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  // 引擎注入 `_model`（每步可覆盖）；直接调用（测试）时回退到 config 默认模型
  const model = (ctx as unknown as { _model?: string })._model ?? ctx.config.models.default;
  const beats = (prev[2]?.data.storyboard as { beats: Beat[] } | undefined)?.beats ?? [];
  const boundaries = (prev[3]?.data.boundaries as { index: number; startSec: number; endSec: number }[] | undefined) ?? [];
  const design = (prev[1]?.data.design as string | undefined) ?? (existsSync(join(ctx.projectDir, "DESIGN.md")) ? readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8") : "");
  const { w, h } = RESOLUTIONS[ctx.config.format];

  const timedBeats = beats.map((b, i) => {
    // 生产链路 storyboard beat 自带 index（1-based）；缺失时按位置兜底
    const bound = boundaries.find((x) => x.index === (b.index ?? i + 1));
    return { ...b, startSec: bound?.startSec ?? b.durationSec * i, endSec: bound?.endSec ?? b.durationSec * (i + 1) };
  });

  // 素材清单
  const assetList = [
    ...ctx.config.materials.images.map((f) => `assets/${f} (image)`),
    ...(ctx.config.materials.audio ? [`assets/${ctx.config.materials.audio} (audio)`] : []),
  ].join("\n");

  // 1) root index.html：软目标收尾。真实总长（step3 实测边界末尾）若短于目标时长，
  //    则把末 beat 结束点补齐到 target（留固定下限 0.6s），让视频撑住直到配音放完；
  //    若视频已拼过目标（totalReal > target），则保留实测并仅加下限，绝不让视频提前结束。
  const totalReal = boundaries.at(-1)?.endSec ?? 0;
  const target = ctx.config.durationSec;
  const tailHold = Math.max(0.6, Math.min(target - totalReal, target * 0.5));
  if (tailHold > 0 && timedBeats.length > 0) {
    timedBeats[timedBeats.length - 1].endSec = totalReal + tailHold;
  }
  const finalEndSec = timedBeats.at(-1)?.endSec ?? target;

  const indexHtml = generateRootHtml({
    beats: timedBeats.map((b) => ({ id: b.id, startSec: b.startSec, endSec: b.endSec })),
    format: ctx.config.format,
    totalSec: finalEndSec,
    voiceover: ctx.config.voiceover,
    bgm: ctx.config.materials.audio,
    language: ctx.config.language,
    finalEndSec,
  });
  writeFileSync(join(ctx.projectDir, "index.html"), indexHtml);

  // 2) 每 beat 生成 + lint 门
  mkdirSync(join(ctx.projectDir, "compositions"), { recursive: true });
  const built: { id: string; file: string; startSec: number; endSec: number; attempts: number }[] = [];
  const gateErrors: string[] = [];

  for (const beat of timedBeats) {
    let attempts = 0;
    let ok = false;
    while (!ok && attempts < 3) {
      attempts++;
      const beatSpec = JSON.stringify({
        id: beat.id,
        startSec: beat.startSec,
        endSec: beat.endSec,
        narration: beat.narration,
        mood: beat.mood,
        techniques: beat.techniques,
        transitions: beat.transitions,
        assets: beat.assets,
      }, null, 2);
      const userContent = `片段规格：\n${beatSpec}\n\nDESIGN.md：\n${design.slice(0, 8000)}\n\n素材清单：\n${assetList || "（无）"}\n\n画幅：${w}x${h}；输出文件：compositions/${beat.id}.html`;
      const { content } = await ctx.llm.chat({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `${userContent}${ctx.feedback ? `\n\n上次 lint 失败反馈（必须修复这些错误）：\n${ctx.feedback}` : ""}` },
        ],
        temperature: 0.5,
        seed: 44,
        // beat 生成是流水线中最长的输出（完整 HTML 合成）。强制开启思考保证契约遵守，
        // 用中等档思考：deepseek-v4-flash 实测全量思考 10-25 分钟/beat，medium 档分钟级，质量与耗时平衡
        timeoutMs: 900_000,
        // 强制关闭思考：deepseek-v4-flash 等 flash 快速模型的 thinking:enabled 模式实测不稳定
        // （偶发挂起 / 思考占满 max_tokens 致 content 为空 → 写出空壳 HTML / 输出时好时坏），
        // thinking:disabled 下 19-25s 稳定返回完整 HTML（E2E 实测 fast 档 1 分钟/beat）。
        // 质量由 build-beat.txt 质量红线 + lint 硬门兜底，不依赖思考模式。
        thinking: "disabled",
        reasoningEffort: ctx.config.quality === "fast" ? "low" : ctx.config.quality === "high" ? "high" : "medium",
        // 输出上限：防模型无限生成（无 max_tokens 时响应 body 永不结束 → 引擎挂起）。16000 token 足够一个完整 HTML composition。
        maxTokens: 16_000,
      });
      const file = join(ctx.projectDir, "compositions", `${beat.id}.html`);
      // 剥离模型可能包裹的 markdown 代码围栏（推理模型习惯性输出 ```html ... ```，
      // 直接写盘会让 hyperframes 解析失败——E2E 实测 lint 报 root_missing_composition_id 等）
      writeFileSync(file, ensureRootWrapper(stripClipAttrs(ensureCjkFontStack(stripCodeFences(content))), { id: beat.id, w, h }));

      const lint = await ctx.render.lint();
      // 逐 beat lint 门：过滤"引用尚未写入的合成"类错误（写 beat 过程中必然出现），
      // 只对过滤后仍存在的 error 级 finding 判失败。
      const remaining = (lint.findings ?? []).filter((f) => !isMissingFileFinding(f) && f.severity === "error");
      if (remaining.length > 0) {
        const errText = remaining.map((f) => `[${f.code ?? f.rule ?? "?"}] ${f.message}`).join("; ");
        gateErrors.push(`${beat.id} lint 失败(第${attempts}次): ${errText}`);
        ctx.feedback = `${beat.id} 的 lint 错误：${errText}`;
        if (attempts >= 3) {
          return {
            status: "gate_failed",
            artifacts: ["index.html", ...built.map((b) => b.file)],
            data: { beats: built },
            log: `beat 构建 lint 未通过（${beat.id}）`,
            gateErrors,
          };
        }
      } else {
        ok = true;
        built.push({ id: beat.id, file: `compositions/${beat.id}.html`, startSec: beat.startSec, endSec: beat.endSec, attempts });
      }
    }
  }

  // 3) 全部 beat 写完后，跑一次完整 lint：此时引用已全部就位，任何错误
  //    （含仍未解决的缺失引用）都是真实失败，不能再过滤。
  const finalLint = await ctx.render.lint();
  const finalErrors = (finalLint.findings ?? []).filter((f) => f.severity === "error");
  if (finalErrors.length > 0) {
    return {
      status: "gate_failed",
      artifacts: ["index.html", ...built.map((b) => b.file)],
      data: { beats: built },
      log: `全部 ${built.length} 个片段写完后完整 lint 仍有 ${finalErrors.length} 个错误`,
      gateErrors: [
        ...gateErrors,
        `最终 lint ${finalErrors.length} 个错误: ${finalErrors.map((f) => `[${f.code ?? f.rule ?? "?"}] ${f.message}`).join("; ")}`,
      ],
    };
  }

  return {
    status: "passed",
    artifacts: ["index.html", ...built.map((b) => b.file)],
    data: { beats: built, finalEndSec },
    log: `构建完成：${built.length} 个片段，总时长 ${finalEndSec.toFixed(1)}s`,
  };
};
