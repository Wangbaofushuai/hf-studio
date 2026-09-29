import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { StepContext, StepFn, StepResult, Beat } from "../../types";
import type { LintFinding } from "../../render/service";
import { generateRootHtml } from "../root-html";
import { RESOLUTIONS } from "../../render/resolutions";
import { stripCodeFences, ensureCjkFontStack, stripClipAttrs, normalizeBeatAnimations, ensureRootWrapper } from "../../util/clean-output";
import { buildAnchorPrompt, buildBeatPrompt, clampDuration, JIMENG_ANCHOR_RESOLUTION, JIMENG_DURATION_MAX, JIMENG_DURATION_MIN, jimengAnchorModel, jimengDurationSec, jimengModel, jimengPrompt, jimengRatio, jimengResolution, type VisualBible } from "./jimeng-video";
import { JimengConfirmationRequiredError, JimengWaitTimeoutError } from "../../jimeng/errors";
import { isLegacySingleState, type JimengItemState } from "../../jimeng/service";
// 注意：SYSTEM 提示词在模块加载时通过 readFileSync 读取（src/prompts/build-beat.txt）。
// bun --watch 不监控 .txt，改动提示词后需触发本文件内容变化（或重启服务）才能生效。
// 2026-08-10 提示词已强化：布局纪律（防 content_overlap）+ 素材硬约束（防幻觉素材）+ 脚本安全（防 root.getElementById）。

const SYSTEM = readFileSync(new URL("../../prompts/build-beat.txt", import.meta.url), "utf8");

/** jimeng 分镜报价合计 */
function sumJimengQuote(items: Record<string, JimengItemState> | undefined): number {
  return Object.values(items ?? {}).reduce((s, it) => s + (it.quote?.totalMaxCredits ?? 0), 0);
}

/** Phase 1 单条路径的失败映射（确认挂起 / 等待超时 / 其他失败） */
function legacyJimengFailure(e: unknown): StepResult {
  if (e instanceof JimengConfirmationRequiredError) {
    return {
      status: "failed",
      artifacts: ["jimeng/state.json"],
      data: { jimengConfirmation: { key: "main", minimumCreditCeiling: e.minimumCreditCeiling } },
      log: `即梦需要积分确认（报价 ${e.minimumCreditCeiling ?? "未知"} 积分）：请设置任务积分上限后重跑`,
    };
  }
  if (e instanceof JimengWaitTimeoutError) {
    return { status: "gate_failed", artifacts: ["jimeng/state.json"], data: {}, log: e.message, gateErrors: [e.message] };
  }
  return { status: "failed", artifacts: ["jimeng/state.json"], data: {}, log: e instanceof Error ? e.message : String(e) };
}


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
  // —— AI 直出（jimeng）分支：分镜级逐 beat 生成（Phase 2）；Phase 1 单条任务走兼容路径 ——
  if (ctx.config.mode === "jimeng") {
    if (!ctx.jimeng) {
      return { status: "failed", artifacts: [], data: {}, log: "即梦服务未启用：请检查 .tools/dreamina-canvas 安装（或 HF_JIMENG_BIN）" };
    }
    const svc = ctx.jimeng;
    const clipMax = Math.max(JIMENG_DURATION_MIN, Math.min(JIMENG_DURATION_MAX, ctx.config.jimeng?.clipMaxSec ?? JIMENG_DURATION_MAX));
    const baseReq = {
      model: jimengModel(ctx.config),
      ratio: jimengRatio(ctx.config.format),
      resolution: jimengResolution(ctx.config),
      creditCap: ctx.config.jimeng?.creditCap,
    };

    // Phase 1 兼容：state 顶层已有单条工作字段 → 旧逻辑（ensureVideo）
    if (isLegacySingleState(svc.loadState())) {
      const req = {
        ...baseReq,
        prompt: jimengPrompt(ctx.config),
        durationSec: jimengDurationSec(ctx.config),
        title: (ctx.config.idea || "HF-Studio 直出").slice(0, 24),
      };
      try {
        const { state, clipAbsPath } = await svc.ensureVideo(req);
        const rel = relative(ctx.projectDir, clipAbsPath);
        return {
          status: "passed",
          artifacts: ["jimeng/state.json", rel],
          data: { jimeng: state },
          log: `即梦直出完成：${rel}${state.quote ? `（报价 ${state.quote.totalMaxCredits} 积分）` : ""}`,
        };
      } catch (e) {
        return legacyJimengFailure(e);
      }
    }

    const beats = (prev[2]?.data.storyboard as { beats: Beat[] } | undefined)?.beats ?? [];
    if (beats.length === 0) {
      return { status: "failed", artifacts: [], data: {}, log: "jimeng 模式缺少分镜数据（step2 未产出 beats）" };
    }
    const boundaries = (prev[3]?.data.boundaries as { index: number; startSec: number; endSec: number }[] | undefined) ?? [];
    const design = (prev[1]?.data.design as string | undefined) ?? (existsSync(join(ctx.projectDir, "DESIGN.md")) ? readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8") : "");
    void design; // DESIGN 信息已通过 step2 的 visual 块进入提示词（Phase 2.1）
    // 视觉设定（视觉锚点）：来自 step2 的 visual 块或 VISUAL.json
    const visual = (prev[2]?.data.visual as VisualBible | undefined)
      ?? (existsSync(join(ctx.projectDir, "VISUAL.json"))
        ? (JSON.parse(readFileSync(join(ctx.projectDir, "VISUAL.json"), "utf8")).visual as VisualBible)
        : undefined);
    const contentType = prev[2]?.data.contentType as string | undefined;
    const assetsDir = join(ctx.projectDir, "assets");

    // 定妆图（锚点）：生成/复用一张主体参考图，所有 beat m2v 引用，保证同一人物与场景
    let anchorRef: string | null = null;
    if (visual?.subject) {
      try {
        const { anchor } = await svc.ensureAnchorImage({
          prompt: buildAnchorPrompt(visual),
          model: jimengAnchorModel(ctx.config),
          ratio: baseReq.ratio,
          resolution: JIMENG_ANCHOR_RESOLUTION,
          creditCap: baseReq.creditCap,
          title: "主角定妆图",
        });
        if (anchor.nodeId) anchorRef = `node:${anchor.nodeId}`;
      } catch (e) {
        if (e instanceof JimengConfirmationRequiredError) {
          const st = svc.loadState();
          return {
            status: "failed",
            artifacts: ["jimeng/state.json"],
            data: {
              jimeng: { projectId: st.projectId, webUrl: st.webUrl, items: st.items ?? {}, totalQuote: sumJimengQuote(st.items) },
              jimengConfirmation: { key: "anchor", minimumCreditCeiling: e.minimumCreditCeiling, totalQuote: sumJimengQuote(st.items) },
            },
            log: `即梦定妆图需要积分确认：${e.message}`,
          };
        }
        // 锚点失败不阻塞：回退逐段 t2v（连贯性下降，但任务可继续）
        ctx.log(`定妆图生成失败，回退逐段 t2v：${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const items: Record<string, JimengItemState> = {};
    const timed: { id: string; index: number; startSec: number; endSec: number }[] = [];
    let cursor = 0;
    for (const beat of beats) {
      const bound = boundaries.find((x) => x.index === beat.index);
      const startSec = bound?.startSec ?? cursor;
      const endSec = bound?.endSec ?? cursor + beat.durationSec;
      cursor = endSec;
      const reqDur = clampDuration(Math.max(1, endSec - startSec), clipMax);

      let mode: "t2v" | "m2v" = "t2v";
      const refs: string[] = [];
      const asset = (beat.assets ?? []).find((f) => f && existsSync(join(assetsDir, f)));
      if (asset) {
        const { nodeId } = await svc.ensureImageNode(asset, join(assetsDir, asset));
        mode = "m2v";
        refs.push(`node:${nodeId}`);
      } else if (anchorRef) {
        // 无自带素材：引用定妆图，保持同一主体/场景（Phase 2.1 连贯性关键）
        mode = "m2v";
        refs.push(anchorRef);
      }

      try {
        const { item } = await svc.ensureItem(beat.id, {
          ...baseReq,
          prompt: buildBeatPrompt(beat, visual, { contentType }),
          durationSec: reqDur,
          title: `${beat.id} ${beat.title}`.slice(0, 24),
          mode,
          refs,
        });
        items[beat.id] = item;
      } catch (e) {
        const state = svc.loadState();
        if (e instanceof JimengConfirmationRequiredError) {
          return {
            status: "failed",
            artifacts: ["jimeng/state.json"],
            data: {
              jimeng: { projectId: state.projectId, webUrl: state.webUrl, items: state.items ?? {}, totalQuote: sumJimengQuote(state.items) },
              jimengConfirmation: { key: beat.id, minimumCreditCeiling: e.minimumCreditCeiling, totalQuote: sumJimengQuote(state.items) },
            },
            log: `即梦需要积分确认（片段 ${beat.id}）：${e.message}`,
          };
        }
        if (e instanceof JimengWaitTimeoutError) {
          return {
            status: "gate_failed",
            artifacts: ["jimeng/state.json"],
            data: { jimeng: { projectId: state.projectId, webUrl: state.webUrl, items: state.items ?? {} } },
            log: e.message,
            gateErrors: [e.message],
          };
        }
        return { status: "failed", artifacts: ["jimeng/state.json"], data: {}, log: e instanceof Error ? e.message : String(e) };
      }
      timed.push({ id: beat.id, index: beat.index, startSec, endSec });
    }

    const state = svc.loadState();
    const totalQuote = sumJimengQuote(items);
    const artifacts = [
      "jimeng/state.json",
      ...Object.values(items).map((it) => it.clipPath).filter((p): p is string => Boolean(p)),
    ];
    return {
      status: "passed",
      artifacts,
      data: { jimeng: { projectId: state.projectId, webUrl: state.webUrl, items, totalQuote }, beats: timed },
      log: `即梦直出完成：${beats.length} 个片段（合计报价 ${totalQuote} 积分）`,
    };
  }

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
      // 动画契约修正（2026-09-28）：确定性规范化 beat 动画（去掉 immediateRender:false、可见起点 fromTo 改 to()），避免"首帧全显/提前显形"穿帮
      writeFileSync(file, ensureRootWrapper(normalizeBeatAnimations(stripClipAttrs(ensureCjkFontStack(stripCodeFences(content)))), { id: beat.id, w, h }));

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
