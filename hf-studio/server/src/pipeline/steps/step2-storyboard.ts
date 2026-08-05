import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { StepContext, StepFn, StepResult, Brief, Beat, JudgeResult } from "../../types";
import { estimateSec } from "../beat-timing";

const BeatSchema = z.object({
  title: z.string().min(1).max(30),
  narration: z.string(),
  mood: z.string().min(1),
  techniques: z.array(z.string()).min(1).max(4),
  transitions: z.string().min(1),
  assets: z.array(z.string()),
  durationSec: z.number().positive(),
});
const PayloadSchema = z.object({
  storyboardMd: z.string().min(20),
  scriptMd: z.string().min(1),
  beats: z.array(BeatSchema).min(3).max(8),
});

const SYSTEM = readFileSync(new URL("../../prompts/storyboard.txt", import.meta.url), "utf8");

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

export const step2Storyboard: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const model = (ctx as unknown as { _model?: string })._model ?? ctx.config.models.default;
  const brief = (prev[0]?.data.brief ?? JSON.parse(readFileSync(join(ctx.projectDir, "brief.json"), "utf8"))) as Brief;
  const design = (prev[1]?.data.design as string | undefined) ?? (readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8"));
  const themeNote = themeConstraint(ctx.config.theme);

  let payload: z.infer<typeof PayloadSchema>;
  try {
    const { data } = await ctx.llm.chatJson(
      {
        model,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `brief：\n${JSON.stringify(brief, null, 2)}\n\nDESIGN.md：\n${design.slice(0, 8000)}\n\n目标时长：${ctx.config.durationSec} 秒；画幅：${ctx.config.format}；配音：${ctx.config.voiceover ? "开" : "关"}${themeNote ? `\n\n主题约束：\n${themeNote}` : ""}${ctx.feedback ? `\n\n上次失败反馈（修正后重试）：\n${ctx.feedback}` : ""}`,
          },
        ],
        temperature: 0.7,
        seed: 33,
      },
      PayloadSchema,
    );
    payload = data;
  } catch (e) {
    return { status: "gate_failed", artifacts: [], data: {}, log: `分镜解析失败: ${e instanceof Error ? e.message : String(e)}`, gateErrors: [`分镜结构校验失败：${e instanceof Error ? e.message : String(e)}`] };
  }

  // 结构校验
  const errors: string[] = [];
  const total = payload.beats.reduce((s, b) => s + b.durationSec, 0);
  const dev = Math.abs(total - ctx.config.durationSec) / ctx.config.durationSec;
  if (dev > 0.2) errors.push(`片段总时长 ${total.toFixed(1)}s 与目标 ${ctx.config.durationSec}s 偏差 ${(dev * 100).toFixed(0)}% > 20%`);
  if (ctx.config.voiceover) {
    payload.beats.forEach((b, i) => { if (!b.narration.trim()) errors.push(`Beat ${i + 1} 缺少旁白`); });
    // 旁白长度门：视频时长 = 旁白时长（配音模式），旁白必须填满目标时长——
    // 否则 LLM 会虚增 durationSec 骗过上面的时长门，产出远短于目标时长的视频（E2E 实测 8.7s vs 15s）
    const narrationSec = payload.beats.reduce((s, b) => s + estimateSec(b.narration, ctx.config.language), 0);
    const narrDev = Math.abs(narrationSec - ctx.config.durationSec) / ctx.config.durationSec;
    if (narrDev > 0.2) {
      errors.push(`旁白总时长 ${narrationSec.toFixed(1)}s 与目标 ${ctx.config.durationSec}s 偏差 ${(narrDev * 100).toFixed(0)}% > 20%（请加长/精简旁白以匹配目标时长）`);
    }
  }
  if (errors.length > 0) {
    return { status: "gate_failed", artifacts: [], data: {}, log: `分镜结构校验失败`, gateErrors: errors };
  }

  const beats: Beat[] = payload.beats.map((b, i) => ({ index: i + 1, id: `beat-${i + 1}`, ...b }));
  writeFileSync(join(ctx.projectDir, "STORYBOARD.md"), payload.storyboardMd);
  writeFileSync(join(ctx.projectDir, "SCRIPT.md"), payload.scriptMd);

  let judgeResult: JudgeResult;
  try {
    judgeResult = await ctx.judge.score("storyboard", `${payload.storyboardMd}\n\n${JSON.stringify(payload.beats, null, 2)}`, brief);
  } catch (e) {
    // 评审器调用本身失败（如评审 JSON 解析失败）→ 按评审未过处理，交由引擎评审重试循环
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "judge_failed",
      artifacts: ["STORYBOARD.md", "SCRIPT.md"],
      data: { storyboard: { beats }, scriptMd: payload.scriptMd, storyboardMd: payload.storyboardMd },
      log: `分镜评审调用失败：${msg}`,
      judge: { score: 0, rubric: {}, feedback: `评审器调用失败：${msg}` },
    };
  }
  if (!ctx.judge.passes(judgeResult)) {
    return {
      status: "judge_failed",
      artifacts: ["STORYBOARD.md", "SCRIPT.md"],
      data: { storyboard: { beats }, scriptMd: payload.scriptMd, storyboardMd: payload.storyboardMd },
      log: `分镜评审 ${judgeResult.score} 分`,
      judge: judgeResult,
    };
  }
  return {
    status: "passed",
    artifacts: ["STORYBOARD.md", "SCRIPT.md"],
    data: { storyboard: { beats }, scriptMd: payload.scriptMd, storyboardMd: payload.storyboardMd },
    log: `分镜完成：${beats.length} 个片段（评审 ${judgeResult.score} 分）`,
    judge: judgeResult,
  };
};
