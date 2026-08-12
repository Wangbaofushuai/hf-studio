import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JobStore } from "../db/store";
import { LlmGateway, type LlmProvider } from "../llm/gateway";
import { LlmApiError } from "../llm/errors";
import { Judge } from "../judge/judge";
import type { RenderService } from "../render/service";
import type { TtsService } from "../tts/service";
import type { JobStatus, StepContext, StepFn, StepId, StepOutput, StepResult } from "../types";

export interface Services {
  llm: LlmGateway;
  judge: Judge;
  judgeModel?: string;
  baseProviders?: LlmProvider[];
  render: (projectDir: string) => RenderService;
  tts: TtsService;
}
export type EngineEvent =
  | { type: "job_status"; jobId: string; status: JobStatus; currentStep: StepId | null; message: string }
  | { type: "step_status"; jobId: string; step: StepId; status: "running" | "passed" | "failed"; log: string };

export interface EngineOptions {
  store: JobStore;
  steps: StepFn[];
  services: Services;
  projectRoot: string;
  maxConcurrency?: number; // 并发上限（默认 2）；≤1 退化为串行
}

const MAX_HARD_RETRIES = 3;
const MAX_JUDGE_RETRIES = 2;
const MAX_LLM_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 合并内置渠道与任务自定义渠道：自定义优先（同名覆盖） */
export function mergeProviders(base: LlmProvider[], custom?: LlmProvider[]): LlmProvider[] {
  const map = new Map<string, LlmProvider>();
  for (const p of base ?? []) map.set(p.id, p);
  for (const p of custom ?? []) map.set(p.id, p);
  return [...map.values()];
}

export class PipelineEngine {
  private active = new Map<string, Promise<void>>();
  private maxConcurrency: number;
  private listeners: ((e: EngineEvent) => void)[] = [];
  constructor(private opts: EngineOptions) {
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 2);
  }

  onEvent(cb: (e: EngineEvent) => void): void { this.listeners.push(cb); }
  offEvent(cb: (e: EngineEvent) => void): void { this.listeners = this.listeners.filter((l) => l !== cb); }
  private emit(e: EngineEvent): void { for (const cb of this.listeners) cb(e); }

  enqueue(jobId: string): void {
    this.schedule();
  }

  rerunFrom(jobId: string, step: StepId): void {
    this.opts.store.rerunFrom(jobId, step);
    this.schedule();
  }

  /** 补位调度：有 queued 任务且有空闲槽位 → 按 FIFO 取出执行（幂等，可被入队/rerun/任务结束反复触发）
   *  终止性：runJob 必须让任务离开 queued（含异常路径），否则 schedule() 会无限重调度同一任务 */
  private schedule(): void {
    while (this.active.size < this.maxConcurrency) {
      // 跳过已在 active 中的任务：runJob 的 initProject 在 beginStep 之前 await，
      // DB 状态尚未从 queued 转 running，直接取 [0] 会无限重跑同一任务（死循环）
      const next = this.opts.store.listQueued().find((j) => !this.active.has(j.id));
      if (!next) break;
      const jobId = next.id;
      const p = this.runJob(jobId).finally(() => {
        this.active.delete(jobId);
        this.schedule(); // 任务结束补位
      });
      this.active.set(jobId, p);
    }
  }

  /** 等待所有在途任务执行完毕（幂等）。schedule 同步启动任务，join 当前快照后循环重扫，
   *  兜住任务结束时 finally 里新调度起的任务，直到无 queued 且无 active。 */
  async processNext(): Promise<void> {
    for (;;) {
      this.schedule();
      const current = [...this.active.values()];
      if (current.length === 0) break;
      await Promise.allSettled(current);
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const store = this.opts.store;
    const job = store.getJob(jobId);
    if (!job) return;
    try {
      const projectDir = join(this.opts.projectRoot, jobId);
      mkdirSync(projectDir, { recursive: true });
      // 生产链路在 step0 之前初始化项目脚手架（meta.json/hyperframes.json/package.json，
      // 及全新目录下的空白 index.html）。initProject 对 index.html 采用"存在则跳过"，
      // rerunFrom 恢复时不会覆盖 step4 生成的真实 index.html；step5 的脚手架兜底守卫
      // 因 meta.json 已存在而保持惰性。测试桩 render 无 initProject 方法时跳过。
      const render = this.opts.services.render(projectDir);
      if ("initProject" in render) {
        await render.initProject(jobId, job.config.format);
      }
      this.emit({ type: "job_status", jobId, status: "running", currentStep: job.currentStep, message: "started" });

      // 按任务组装渠道：自定义渠道（前端 BYOK）优先于内置渠道
      const providers = mergeProviders(this.opts.services.baseProviders ?? [], job.config.providers);
      const hasCustom = (job.config.providers?.length ?? 0) > 0;
      const llm = hasCustom ? new LlmGateway(providers) : this.opts.services.llm;
      // 评审模型：配置了 judgeModel 用共享 Judge；否则按任务默认模型动态构建
      // （config 只提供预设渠道时 judgeModel 为空——E2E 实测空模型报 unknown provider）
      const judge = hasCustom || !this.opts.services.judgeModel
        ? new Judge(llm, job.config.models.default, this.opts.services.judge?.threshold ?? 7)
        : this.opts.services.judge;

      const prev = store.getStepOutputs(jobId);
      const startStep = (job.currentStep ?? 0) as StepId;
      let lastStatus: JobStatus = "completed";

      for (let step = startStep; step < this.opts.steps.length; step++) {
        const stepFn = this.opts.steps[step];
        if (!stepFn) { lastStatus = "failed"; break; }
        store.beginStep(jobId, step as StepId);
        this.emit({ type: "step_status", jobId, step: step as StepId, status: "running", log: "" });
        const out = await this.runStepWithRetries(step as StepId, stepFn, jobId, projectDir, job.config.models, prev, llm, judge);
        store.finishStep(jobId, step as StepId, out);
        prev.push(out);
        this.emit({ type: "step_status", jobId, step: step as StepId, status: out.status === "passed" ? "passed" : "failed", log: out.log });
        if (out.status !== "passed") {
          lastStatus = out.status === "judge_failed" || out.status === "gate_failed" ? "needs_review" : "failed";
          store.updateJob(jobId, { status: lastStatus, error: out.error ?? null });
          this.emit({ type: "job_status", jobId, status: lastStatus, currentStep: step as StepId, message: out.log });
          return;
        }
      }
      store.updateJob(jobId, { status: "completed", error: null });
      this.emit({ type: "job_status", jobId, status: "completed", currentStep: null, message: "done" });
    } catch (e) {
      // 终止性（异常路径）：任何未预期错误（initProject / emit / store 同步调用）都让任务
      // 离开 queued 进入 failed，否则 finally 补位时 schedule() 会无限重调度同一任务，
      // 每轮都是微任务，事件循环（含 HTTP server）会挂死无恢复。
      const msg = e instanceof Error ? e.message : String(e);
      store.updateJob(jobId, { status: "failed", error: msg });
    }
  }

  private async runStepWithRetries(
    step: StepId, stepFn: StepFn, jobId: string, projectDir: string,
    models: { default: string; steps?: Partial<Record<StepId, string>> }, prev: StepOutput[],
    llm: LlmGateway, judge: Judge,
  ): Promise<StepOutput> {
    const store = this.opts.store;
    const model = models.steps?.[step] ?? models.default;
    let hard = 0, judgeRetries = 0, llmRetries = 0;
    let feedback: string | null = null;
    let attempts = 0;

    for (;;) {
      attempts++;
      const ctx: StepContext = {
        jobId, projectDir, config: store.getJob(jobId)!.config,
        llm, judge,
        store, render: this.opts.services.render(projectDir), tts: this.opts.services.tts,
        feedback, log: () => {},
      };
      (ctx as StepContext & { _model: string })._model = model;
      (ctx as StepContext & { _renderQuality: string })._renderQuality = store.getJob(jobId)!.config.renderQuality ?? "standard";
      try {
        const r: StepResult = await stepFn(ctx, prev);
        if (r.status === "passed") {
          return { step, status: "passed", artifacts: r.artifacts, data: r.data, log: r.log, judge: r.judge, attempts };
        }
        if (r.status === "gate_failed") {
          if (hard < MAX_HARD_RETRIES) {
            hard++;
            feedback = `[校验失败 第${hard}/${MAX_HARD_RETRIES}次] ${(r.gateErrors ?? []).join("; ")}`;
            continue;
          }
          return { step, status: "gate_failed", artifacts: r.artifacts, data: r.data, log: r.log, judge: r.judge, error: `校验门连续失败 ${MAX_HARD_RETRIES} 次：${(r.gateErrors ?? []).join("; ")}`, attempts };
        }
        if (r.status === "judge_failed") {
          if (judgeRetries < MAX_JUDGE_RETRIES) {
            judgeRetries++;
            feedback = `[评审未过 第${judgeRetries}/${MAX_JUDGE_RETRIES}次] ${r.judge?.feedback ?? ""}`;
            continue;
          }
          return { step, status: "judge_failed", artifacts: r.artifacts, data: r.data, log: r.log, judge: r.judge, error: `质量评审连续未过 ${MAX_JUDGE_RETRIES} 次：${r.judge?.feedback ?? ""}`, attempts };
        }
        return { step, status: "failed", artifacts: [], data: {}, log: r.log, error: r.log, attempts };
      } catch (e) {
        if (e instanceof LlmApiError && e.retryable && llmRetries < MAX_LLM_RETRIES) {
          llmRetries++;
          await sleep(1000 * 2 ** (llmRetries - 1));
          feedback = `[LLM 调用失败 第${llmRetries}/${MAX_LLM_RETRIES}次] ${e.message}`;
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        return { step, status: "failed", artifacts: [], data: {}, log: msg, error: msg, attempts };
      }
    }
  }

  shutdown(): void { /* no-op: 队列为惰性 worker 池 */ }
}
