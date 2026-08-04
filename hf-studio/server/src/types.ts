// server/src/types.ts —— 全部类型（Task 1 创建，后续任务只 import）
import type { LlmGateway } from "../llm/gateway";
import type { Judge } from "../judge/judge";
import type { JobStore } from "../db/store";
import type { RenderService } from "../render/service";
import type { TtsService } from "../tts/service";

export type StepId = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type JobStatus = "queued" | "running" | "failed" | "needs_review" | "completed";

export interface LlmProvider {
  id: string;                                     // 渠道名，如 "deepseek"、"mykey"
  baseURL: string;                                // OpenAI 兼容端点，如 https://api.deepseek.com/v1
  apiKey: string;
  models: string[];                               // 该渠道可用模型 id
  temperature?: number;
}

export interface JobConfig {
  idea: string;                                   // 用户想法（中文/任意语言）
  durationSec: number;                            // 5–120
  format: "landscape" | "portrait" | "square";
  voiceover: boolean;
  voice: string;                                  // msedge-tts voice id，如 "zh-CN-XiaoxiaoNeural"
  language: string;                               // 旁白语言，如 "zh-CN"
  models: { default: string; steps?: Partial<Record<StepId, string>> };  // 形如 "deepseek/deepseek-chat"
  materials: { images: string[]; audio: string | null };  // assets/ 下的文件名
  providers?: LlmProvider[];                      // 前端 BYOK 自定义渠道（可选）；合并时优先于同名内置渠道
}

export interface Brief {
  title: string;
  summary: string;
  style: string;
  message: string;
  audience: string;
  arc: string;
  narrationLanguage: string;
  beatCountHint: number;                          // 3–8
}

export interface Beat {
  index: number;                                  // 1-based
  id: string;                                     // "beat-1"
  title: string;
  narration: string;                              // 旁白原文；voiceover=false 时可为空
  mood: string;
  techniques: string[];
  transitions: string;
  assets: string[];                               // assets/ 下文件名
  durationSec: number;                            // 估算（无配音）或来自 transcript（有配音，step4 填充）
  startSec?: number;                              // step4 填充
  endSec?: number;
}

export interface JudgeResult { score: number; rubric: Record<string, number>; feedback: string; }

export interface StepResult {
  status: "passed" | "gate_failed" | "judge_failed";
  artifacts: string[];                            // 项目相对路径
  data: Record<string, unknown>;
  log: string;                                    // 给 UI 的摘要
  gateErrors?: string[];
  judge?: JudgeResult;
}

export interface StepOutput {                     // 持久化（step_runs 表）
  step: StepId;
  status: StepResult["status"];
  artifacts: string[];
  data: Record<string, unknown>;
  log: string;
  judge?: JudgeResult;
  error?: string;
  attempts: number;
}

export interface StepContext {
  jobId: string;
  projectDir: string;                             // data/projects/<jobId>
  config: JobConfig;
  llm: LlmGateway;
  judge: Judge;
  store: JobStore;
  render: RenderService;
  tts: TtsService;
  feedback: string | null;                        // 引擎在重试前注入的上次失败反馈
  log: (msg: string) => void;
}
export type StepFn = (ctx: StepContext, prev: StepOutput[]) => Promise<StepResult>;
