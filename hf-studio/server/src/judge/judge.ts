import { readFileSync } from "node:fs";
import { z } from "zod";
import type { LlmGateway } from "../llm/gateway";
import type { Brief, JudgeResult } from "../types";

const RATING = z.object({
  rubric: z.object({ clarity: z.number(), pacing: z.number(), visualRichness: z.number(), match: z.number() }),
  score: z.number(),
  feedback: z.string(),
});

const RUBRIC = readFileSync(new URL("../prompts/judge-rubric.txt", import.meta.url), "utf8");

export class Judge {
  constructor(private llm: LlmGateway, private model: string, public readonly threshold: number) {}

  async score(kind: "design" | "storyboard", artifactText: string, brief: Brief): Promise<JudgeResult> {
    const { data } = await this.llm.chatJson(
      {
        model: this.model,
        messages: [
          { role: "system", content: RUBRIC },
          {
            role: "user",
            content: `brief:\n${JSON.stringify(brief, null, 2)}\n\n待评审文档（${kind}）：\n${artifactText.slice(0, 12000)}`,
          },
        ],
        temperature: 0.2,
        seed: 42,
        // 评审调用挂起同样会卡死任务：120s 内必须返回，超时按评审失败走引擎重试循环
        timeoutMs: 120_000,
      },
      RATING,
    );
    return { score: data.score, rubric: data.rubric, feedback: data.feedback };
  }

  passes(r: JudgeResult): boolean {
    return r.score >= this.threshold;
  }
}
