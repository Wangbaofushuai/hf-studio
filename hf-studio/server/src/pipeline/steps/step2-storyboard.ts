import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { StepContext, StepFn, StepResult, Brief, Beat, JudgeResult } from "../../types";

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

export const step2Storyboard: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const model = (ctx as unknown as { _model?: string })._model ?? ctx.config.models.default;
  const brief = (prev[0]?.data.brief ?? JSON.parse(readFileSync(join(ctx.projectDir, "brief.json"), "utf8"))) as Brief;
  const design = (prev[1]?.data.design as string | undefined) ?? (readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8"));

  let payload: z.infer<typeof PayloadSchema>;
  try {
    const { data } = await ctx.llm.chatJson(
      {
        model,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `brief：\n${JSON.stringify(brief, null, 2)}\n\nDESIGN.md：\n${design.slice(0, 8000)}\n\n目标时长：${ctx.config.durationSec} 秒；画幅：${ctx.config.format}；配音：${ctx.config.voiceover ? "开" : "关"}${ctx.feedback ? `\n\n上次失败反馈（修正后重试）：\n${ctx.feedback}` : ""}`,
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
