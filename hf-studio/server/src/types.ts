// server/src/types.ts —— 全部类型（Task 1 创建，后续任务只 import）
import type { LlmGateway } from "./llm/gateway";
import type { Judge } from "./judge/judge";
import type { JobStore } from "./db/store";
import type { RenderService } from "./render/service";
import type { TtsService } from "./tts/service";
import type { JimengService } from "./jimeng/service";

export type StepId = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type JobStatus = "queued" | "running" | "failed" | "needs_review" | "completed";
export type JobMode = "hyperframes" | "jimeng";   // 制作方式：代码渲染（默认） / 即梦 AI 直出

export interface LlmProvider {
  id: string;                                     // 渠道名，如 "deepseek"、"mykey"
  baseURL: string;                                // OpenAI 兼容端点，如 https://api.deepseek.com/v1
  apiKey: string;
  models: string[];                               // 该渠道可用模型 id
  temperature?: number;
  thinking?: "enabled" | "disabled";              // 推理模型思考开关：disabled 时请求带 thinking:{type:"disabled"}（deepseek-v4-flash 支持，生成速度提升 10 倍+）
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
  theme?: {                                      // 主题预设（可选）；透传到 step1/step2 约束 prompt
    id: string;                                  // 主题关键词表键，如 "tech"/"nature"/"dark"...
    hue?: { primary?: string; accent?: string }; // 主色/强调色 HEX
  };
  renderQuality?: "standard" | "high";           // 渲染清晰度档位（hyperframes render --quality）；默认 standard
  quality?: "fast" | "balanced" | "high";        // 生成快慢档：step4/5 思考强度 low/medium/high；默认 fast
  subtitles?: boolean;                             // 旁白字幕烧录（默认开启；voiceover=false 时跳过）
  mode?: JobMode;                                  // 制作方式；缺省 hyperframes（兼容老任务）
  jimeng?: {                                       // mode=jimeng 时生效
    model?: string;                                // `model list --type video` 的 canonical model；缺省 seedance_2.5_draft
    resolution?: string;                           // 缺省随模型（draft=480p）
    anchorModel?: string;                          // 定妆图（锚点）图片模型；缺省 high_aes_general_v50_flash
    creditCap?: number;                            // 单任务积分上限：报价 ≤ 上限才自动运行
    clipMaxSec?: number;                           // 单片段时长上限（Phase 2 分镜用）
  };
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
  // jimeng 直出（Phase 2.1 连贯性）：镜头类型与画面动作；hyperframes 模式不使用
  shotType?: "establishing" | "closeup" | "over_shoulder" | "gesture" | "insert" | string;
  visualAction?: string;
}

export interface JudgeResult { score: number; rubric: Record<string, number>; feedback: string; }

export interface StepResult {
  status: "passed" | "gate_failed" | "judge_failed" | "failed";  // 硬失败（如 LLM 重试耗尽）由引擎置为 "failed"
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
  jimeng?: JimengService;                         // mode=jimeng 时由引擎注入
  feedback: string | null;                        // 引擎在重试前注入的上次失败反馈
  log: (msg: string) => void;
}
export type StepFn = (ctx: StepContext, prev: StepOutput[]) => Promise<StepResult>;
