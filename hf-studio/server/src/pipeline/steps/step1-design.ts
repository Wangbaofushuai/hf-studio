import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult, Brief, JudgeResult } from "../../types";

const SYSTEM = readFileSync(new URL("../../prompts/design.txt", import.meta.url), "utf8");

// 主题关键词表（与前端主题预设同步）：theme.id → 关键词
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

export const step1Design: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const model = (ctx as unknown as { _model?: string })._model ?? ctx.config.models.default;
  const brief = (prev[0]?.data.brief ?? JSON.parse(readFileSync(join(ctx.projectDir, "brief.json"), "utf8"))) as Brief;
  const themeNote = themeConstraint(ctx.config.theme);

  const { content } = await ctx.llm.chat({
    model,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `brief：\n${JSON.stringify(brief, null, 2)}\n\n素材清单：\n${JSON.stringify(ctx.config.materials, null, 2)}${themeNote ? `\n\n主题约束：\n${themeNote}` : ""}${ctx.feedback ? `\n\n评审反馈（必须针对性修正）：\n${ctx.feedback}` : ""}`,
      },
    ],
    temperature: 0.7,
    seed: 22,
    // DESIGN.md 是文本输出，120s 足够；挂起渠道必须在有限时间内失败而不是无限等待
    timeoutMs: 120_000,
  });
  const design = content.trim();
  writeFileSync(join(ctx.projectDir, "DESIGN.md"), design);

  let judgeResult: JudgeResult;
  try {
    judgeResult = await ctx.judge.score("design", design, brief);
  } catch (e) {
    // 评审器调用本身失败（如评审 JSON 解析失败）→ 按评审未过处理，交由引擎评审重试循环
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "judge_failed",
      artifacts: ["DESIGN.md"],
      data: { design },
      log: `DESIGN 评审调用失败：${msg}`,
      judge: { score: 0, rubric: {}, feedback: `评审器调用失败：${msg}` },
    };
  }
  if (!ctx.judge.passes(judgeResult)) {
    return {
      status: "judge_failed",
      artifacts: ["DESIGN.md"],
      data: { design },
      log: `DESIGN 评审 ${judgeResult.score} 分（阈值 ${ctx.judge.threshold}）`,
      judge: judgeResult,
    };
  }
  return {
    status: "passed",
    artifacts: ["DESIGN.md"],
    data: { design },
    log: `DESIGN.md 完成（评审 ${judgeResult.score} 分）`,
    judge: judgeResult,
  };
};
