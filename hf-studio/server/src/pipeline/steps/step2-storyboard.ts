import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { StepContext, StepFn, StepResult, Brief, Beat, JudgeResult } from "../../types";
import { estimateSec } from "../beat-timing";
import { JIMENG_DURATION_MAX, JIMENG_DURATION_MIN, jimengModel, jimengModelMaxSec, jimengPlan } from "./jimeng-video";

const BeatSchema = z.object({
  title: z.string().min(1).max(30),
  narration: z.string(),
  mood: z.string().min(1),
  techniques: z.array(z.string()).min(1).max(4),
  transitions: z.string().min(1),
  assets: z.array(z.string()),
  durationSec: z.coerce.number().positive(),
});
const PayloadSchema = z.object({
  storyboardMd: z.string().min(20),
  scriptMd: z.string().min(1),
  beats: z.array(BeatSchema).min(3).max(8),
});

// jimeng 直出（Phase 2.1）：分镜必须携带视觉设定 + 镜头语言 + 画面动作（不允许逐句直译旁白）
const JimengBeatSchema = z.object({
  title: z.string().min(1).max(30),
  narration: z.string(),
  mood: z.string().min(1),
  shotType: z.enum(["establishing", "closeup", "over_shoulder", "gesture", "insert"]),
  visualAction: z.string().min(4),
  transitions: z.string().min(1),
  assets: z.array(z.string()),
  durationSec: z.coerce.number().positive(),
});
const JimengPayloadSchema = z.object({
  storyboardMd: z.string().min(20),
  scriptMd: z.string().min(1),
  contentType: z.enum(["performance", "explainer"]),
  visual: z.object({
    subject: z.string().min(4),
    scene: z.string().min(4),
    palette: z.string().min(2),
    camera: z.string().min(2),
  }),
  beats: z.array(JimengBeatSchema).min(1).max(8),
});

const SYSTEM = readFileSync(new URL("../../prompts/storyboard.txt", import.meta.url), "utf8");
const JIMENG_SYSTEM = readFileSync(new URL("../../prompts/storyboard-jimeng.txt", import.meta.url), "utf8");

// 主题关键词表（与 step1 / 前端 preset 同步）：theme.id → 关键词
const THEME_KEYWORDS: Record<string, string> = {
  tech: "深蓝紫霓虹/网格/数据感/高对比",
  nature: "米白绿/柔和圆角/大留白/自然光",
  business: "白深灰蓝/大字号/克制动效/专业权威",
  warm: "奶油橙棕/圆润/亲和/教育",
  retro: "暖黄锈红/颗粒/衬线大字/年代感",
  dark: "近黑底/荧光强调/霓虹边框/大标题",
};

/** 主题约束注入：选中主题时给 LLM 明确的色相与关键词约束；未选中返回空串（行为不变） */
function themeConstraint(t?: { id: string; hue?: { primary?: string; accent?: string } }): string {
  if (!t) return "";
  const kw = THEME_KEYWORDS[t.id] ?? "";
  return `主题：${t.id}${kw ? `, ${kw}` : ""} 主色:${t.hue?.primary ?? "未指定"} 强调色:${t.hue?.accent ?? "未指定"}，主色与强调色必须采用给定值（除非与画幅/可读性冲突），其余色板按主题推导；未指定则自由发挥。`;
}


/** 思考深度（由向导「思考深度/生成速度」映射）：fast=关思考，balanced=中等，high=高强度 */
function thinkingOpts(q: "fast" | "balanced" | "high" | undefined): { thinking: "enabled" | "disabled"; reasoningEffort: "low" | "medium" | "high" } {
  if (q === "balanced") return { thinking: "enabled", reasoningEffort: "medium" };
  if (q === "high") return { thinking: "enabled", reasoningEffort: "high" };
  return { thinking: "disabled", reasoningEffort: "low" };
}

export const step2Storyboard: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {

  const model = (ctx as unknown as { _model?: string })._model ?? ctx.config.models.default;
  const brief = (prev[0]?.data.brief ?? JSON.parse(readFileSync(join(ctx.projectDir, "brief.json"), "utf8"))) as Brief;
  const design = (prev[1]?.data.design as string | undefined) ?? (readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8"));
  const themeNote = themeConstraint(ctx.config.theme);
  const isJimeng = ctx.config.mode === "jimeng";
  const plan = isJimeng ? jimengPlan(ctx.config) : null;
  const system = isJimeng ? JIMENG_SYSTEM : SYSTEM;
  const modeNote = isJimeng
    ? plan === "single"
      ? `\n\n制作方式：AI 直出（即梦视频生成），本次为【直出模式】：**忽略 brief.beatCountHint，只输出 1 个片段**（整段台词长度 ≈ 目标时长 × 4 字/秒，${ctx.config.durationSec}s ≈ ${Math.round(ctx.config.durationSec * 4)} 个汉字，允许 ±10%）；visualAction 描述这一条连续镜头里的整段表演变化，shotType 用 establishing 或 closeup；除直出要求外，仍须遵守视觉连续性、镜头语言与禁止事项。`
      : `\n\n制作方式：AI 直出（即梦视频生成），本次为【分镜拼接模式】（目标时长超过模型单次生成上限）：请输出 3-8 个镜头片段（每个 ≤15 秒），各段台词为该段旁白，仍须遵守视觉连续性、镜头语言与禁止事项。`
    : "";

  let payload: z.infer<typeof PayloadSchema> | z.infer<typeof JimengPayloadSchema>;
  try {
    const { data } = await ctx.llm.chatJson(
      {
        model,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `brief：\n${JSON.stringify(plan === "single" ? { ...brief, beatCountHint: 1 } : brief, null, 2)}\n\nDESIGN.md：\n${design.slice(0, 8000)}\n\n目标时长：${ctx.config.durationSec} 秒；画幅：${ctx.config.format}；配音：${ctx.config.voiceover ? "开" : "关"}${themeNote ? `\n\n主题约束：\n${themeNote}` : ""}${modeNote}${ctx.feedback ? `\n\n上次失败反馈（修正后重试）：\n${ctx.feedback}` : ""}`,
          },
        ],
        temperature: 0.7,
        seed: 33,
        // 分镜+脚本是文本输出，120s 足够；挂起渠道必须在有限时间内失败而不是无限等待
        timeoutMs: 120_000,
        ...thinkingOpts(ctx.config.quality),
      },
      isJimeng ? (JimengPayloadSchema as unknown as typeof PayloadSchema) : PayloadSchema,
    );
    payload = data as z.infer<typeof PayloadSchema> | z.infer<typeof JimengPayloadSchema>;
  } catch (e) {
    return { status: "gate_failed", artifacts: [], data: {}, log: `分镜解析失败: ${e instanceof Error ? e.message : String(e)}`, gateErrors: [`分镜结构校验失败：${e instanceof Error ? e.message : String(e)}`] };
  }

  // jimeng 归一化（必须先于所有门）：
  //  1) 直出模式：LLM 仍返回多片段时确定性合并为 1 条；
  //  2) 时长由台词反推（4 字/秒，夹到 [4, 模型上限]），不再逼台词凑目标时长（用户反馈：时长灵活）
  if (isJimeng) {
    const raw = payload as unknown as z.infer<typeof JimengPayloadSchema>;
    const modelMax = jimengModelMaxSec(jimengModel(ctx.config));
    const singleCap = Math.max(JIMENG_DURATION_MIN, modelMax);
    if (plan === "single") {
      const merged = raw.beats.length > 1
        ? {
            ...raw.beats[0],
            narration: raw.beats.map((b) => b.narration.trim()).filter(Boolean).join(" "),
            shotType: "establishing" as const,
            visualAction: raw.beats.map((b) => b.visualAction.trim()).filter(Boolean).join("；") || "人物面对镜头讲述，手势与表情随内容变化",
            assets: raw.beats.flatMap((b) => b.assets),
          }
        : raw.beats[0];
      const dur = Math.min(Math.max(Math.ceil(estimateSec(merged.narration, ctx.config.language)), JIMENG_DURATION_MIN), singleCap);
      payload = { ...raw, beats: [{ ...merged, durationSec: dur }] } as unknown as typeof payload;
    } else {
      const cap = Math.max(JIMENG_DURATION_MIN, Math.min(JIMENG_DURATION_MAX, modelMax));
      payload = {
        ...raw,
        beats: raw.beats.map((b) => ({
          ...b,
          durationSec: Math.min(Math.max(Math.ceil(estimateSec(b.narration, ctx.config.language)), JIMENG_DURATION_MIN), cap),
        })),
      } as unknown as typeof payload;
    }
  }

  // 结构校验
  const errors: string[] = [];
  if (!isJimeng) {
    const total = payload.beats.reduce((s, b) => s + b.durationSec, 0);
    const dev = Math.abs(total - ctx.config.durationSec) / ctx.config.durationSec;
    if (dev > 0.2) errors.push(`片段总时长 ${total.toFixed(1)}s 与目标 ${ctx.config.durationSec}s 偏差 ${(dev * 100).toFixed(0)}% > 20%`);
  }
  const needNarration = ctx.config.voiceover || isJimeng;
  if (needNarration) {
    payload.beats.forEach((b, i) => { if (!b.narration.trim()) errors.push(`Beat ${i + 1} 缺少${isJimeng ? "台词（原生配音）" : "旁白"}`); });
    // 旁白长度门：仅 hyperframes（视频时长 = 旁白时长，需填满目标）；
    // jimeng 的片段时长由台词反推（见上方归一化），不再需要凑数门
    if (!isJimeng) {
      const narrationSec = payload.beats.reduce((s, b) => s + estimateSec(b.narration, ctx.config.language), 0);
      const narrDev = Math.abs(narrationSec - ctx.config.durationSec) / ctx.config.durationSec;
      if (narrDev > 0.2) {
        errors.push(`旁白总时长 ${narrationSec.toFixed(1)}s 与目标 ${ctx.config.durationSec}s 偏差 ${(narrDev * 100).toFixed(0)}% > 20%（请加长/精简旁白以匹配目标时长）`);
      }
    }
  }
  // jimeng：直出（1 条）与拼接（≥3 条）的计划校验；单 beat 窗口不得超模型上限
  if (ctx.config.mode === "jimeng") {
    if (plan === "single" && payload.beats.length !== 1) {
      errors.push(`直出模式要求 1 个片段（当前 ${payload.beats.length} 个，请合并为 1 条完整口播）`);
    }
    if (plan === "beats" && payload.beats.length < 3) {
      errors.push(`分镜拼接模式至少 3 个片段（当前 ${payload.beats.length} 个）`);
    }
    const max = Math.max(JIMENG_DURATION_MIN, Math.min(JIMENG_DURATION_MAX, ctx.config.jimeng?.clipMaxSec ?? JIMENG_DURATION_MAX));
    payload.beats.forEach((b, i) => {
      if (b.durationSec > max) {
        errors.push(`Beat ${i + 1} 时长 ${b.durationSec}s 超过即梦单片段上限 ${max}s（请拆分该片段）`);
      }
    });
    if (ctx.config.voiceover) {
      payload.beats.forEach((b, i) => {
        const est = estimateSec(b.narration, ctx.config.language);
        if (est > max) {
          errors.push(`Beat ${i + 1} 旁白约 ${est.toFixed(1)}s 超过即梦单片段上限 ${max}s（请缩短该段旁白）`);
        }
      });
    }
  }
  if (errors.length > 0) {
    return { status: "gate_failed", artifacts: [], data: {}, log: `分镜结构校验失败`, gateErrors: errors };
  }

  const jimengPayload = isJimeng ? (payload as unknown as z.infer<typeof JimengPayloadSchema>) : null;
  const beats: Beat[] = jimengPayload
    ? jimengPayload.beats.map((b, i) => ({
        index: i + 1,
        id: `beat-${i + 1}`,
        title: b.title,
        narration: b.narration,
        mood: b.mood,
        techniques: [],
        transitions: b.transitions,
        assets: b.assets,
        durationSec: b.durationSec,
        shotType: b.shotType,
        visualAction: b.visualAction,
      }))
    : (payload as z.infer<typeof PayloadSchema>).beats.map((b, i) => ({ index: i + 1, id: `beat-${i + 1}`, ...b }));
  const visual = jimengPayload?.visual;
  const contentType = jimengPayload?.contentType;
  const jimengExtra = isJimeng && visual ? { visual, contentType } : {};
  writeFileSync(join(ctx.projectDir, "STORYBOARD.md"), payload.storyboardMd);
  writeFileSync(join(ctx.projectDir, "SCRIPT.md"), payload.scriptMd);
  if (isJimeng && visual) {
    writeFileSync(join(ctx.projectDir, "VISUAL.json"), JSON.stringify({ contentType, visual }, null, 2));
  }

  let judgeResult: JudgeResult;
  try {
    judgeResult = await ctx.judge.score("storyboard", `${payload.storyboardMd}\n\n${JSON.stringify(payload.beats, null, 2)}`, brief);
  } catch (e) {
    // 评审器调用本身失败（如评审 JSON 解析失败）→ 按评审未过处理，交由引擎评审重试循环
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "judge_failed",
      artifacts: ["STORYBOARD.md", "SCRIPT.md"],
      data: { storyboard: { beats }, scriptMd: payload.scriptMd, storyboardMd: payload.storyboardMd, ...jimengExtra },
      log: `分镜评审调用失败：${msg}`,
      judge: { score: 0, rubric: {}, feedback: `评审器调用失败：${msg}` },
    };
  }
  if (!ctx.judge.passes(judgeResult)) {
    return {
      status: "judge_failed",
      artifacts: ["STORYBOARD.md", "SCRIPT.md"],
      data: { storyboard: { beats }, scriptMd: payload.scriptMd, storyboardMd: payload.storyboardMd, ...jimengExtra },
      log: `分镜评审 ${judgeResult.score} 分`,
      judge: judgeResult,
    };
  }
  return {
    status: "passed",
    artifacts: ["STORYBOARD.md", "SCRIPT.md"],
    data: { storyboard: { beats }, scriptMd: payload.scriptMd, storyboardMd: payload.storyboardMd, ...jimengExtra },
    log: `分镜完成：${beats.length} 个片段（评审 ${judgeResult.score} 分）`,
    judge: judgeResult,
  };
};
