import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readFileSync } from "node:fs";
import type { StepContext, StepFn, StepResult, Brief } from "../../types";


/** 思考深度（由向导「思考深度/生成速度」映射）：fast=关思考，balanced=中等，high=高强度 */
function thinkingOpts(q: "fast" | "balanced" | "high" | undefined): { thinking: "enabled" | "disabled"; reasoningEffort: "low" | "medium" | "high" } {
  if (q === "balanced") return { thinking: "enabled", reasoningEffort: "medium" };
  if (q === "high") return { thinking: "enabled", reasoningEffort: "high" };
  return { thinking: "disabled", reasoningEffort: "low" };
}

export const BriefSchema = z.object({
  title: z.string().min(1).max(40),
  summary: z.string().min(1),
  style: z.string().min(1),
  message: z.string().min(1),
  audience: z.string().min(1),
  arc: z.string().min(1),
  narrationLanguage: z.string().min(1),
  beatCountHint: z.number().int().min(3).max(8),
});

const SYSTEM = readFileSync(new URL("../../prompts/parse.txt", import.meta.url), "utf8");

export const step0Parse: StepFn = async (ctx: StepContext): Promise<StepResult> => {

  const model = (ctx as unknown as { _model?: string })._model ?? ctx.config.models.default;
  try {
    const { data, raw } = await ctx.llm.chatJson(
      {
        model,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `用户想法：\n${ctx.config.idea}\n\n配置：\n${JSON.stringify({
              durationSec: ctx.config.durationSec,
              format: ctx.config.format,
              voiceover: ctx.config.voiceover,
              language: ctx.config.language,
              materials: ctx.config.materials,
            })}${ctx.feedback ? `\n\n上次失败反馈（修正后重试）：\n${ctx.feedback}` : ""}`,
          },
        ],
        temperature: 0.4,
        seed: 11,
        // brief 是短文本输出，120s 足够；挂起渠道（失效 baseURL）必须在有限时间内失败，
        // 而不是默认 600s 无限等待让任务卡在 running
        timeoutMs: 120_000,
        ...thinkingOpts(ctx.config.quality),
      },
      BriefSchema,
    );
    const brief: Brief = data;
    writeFileSync(join(ctx.projectDir, "brief.json"), JSON.stringify(brief, null, 2));
    return {
      status: "passed",
      artifacts: ["brief.json"],
      data: { brief },
      log: `brief: ${brief.title}（${brief.beatCountHint} 片段）`,
    };
  } catch (e) {
    return {
      status: "gate_failed",
      artifacts: [],
      data: {},
      log: `brief 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      gateErrors: [`brief 结构校验失败：${e instanceof Error ? e.message : String(e)}`],
    };
  }
};
