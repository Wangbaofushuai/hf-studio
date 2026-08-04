import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult, Brief, JudgeResult } from "../../types";

const SYSTEM = readFileSync(new URL("../../prompts/design.txt", import.meta.url), "utf8");

export const step1Design: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const model = (ctx as unknown as { _model?: string })._model ?? ctx.config.models.default;
  const brief = (prev[0]?.data.brief ?? JSON.parse(readFileSync(join(ctx.projectDir, "brief.json"), "utf8"))) as Brief;

  const { content } = await ctx.llm.chat({
    model,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `brief：\n${JSON.stringify(brief, null, 2)}\n\n素材清单：\n${JSON.stringify(ctx.config.materials, null, 2)}${ctx.feedback ? `\n\n评审反馈（必须针对性修正）：\n${ctx.feedback}` : ""}`,
      },
    ],
    temperature: 0.7,
    seed: 22,
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
