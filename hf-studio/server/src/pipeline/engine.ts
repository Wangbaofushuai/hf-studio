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
  baseProviders?: LlmProvider[];                                  // 内置渠道（config.json）
  render: (projectDir: string) => RenderService;
  tts: TtsService;
}
export type EngineEvent =
  | { type: "job_status"; jobId: string; status: JobStatus; currentStep: StepId | null; message: string }
  | { type: "step_status"; jobId: string; step: StepId; status: "running" | "passed" | "failed"; log: string };

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
  // 单飞（single-flight）：一次只跑一轮 drain。与简版 busy 标志不同，busy 时后续
  // processNext() 直接返回会丢掉"等待"语义（rerunFrom → enqueue 抢先置忙，调用方
  // await processNext() 落空）。这里 busy 时返回在途 drain 的同一个 promise，使
  // `await processNext()` 真正等到当前轮处理结束。
  private running: Promise<void> | null = null;
  private listeners: ((e: EngineEvent) => void)[] = [];
  constructor(private opts: { store: JobStore; steps: StepFn[]; services: Services; projectRoot: string }) {}

  onEvent(cb: (e: EngineEvent) => void): void { this.listeners.push(cb); }
  offEvent(cb: (e: EngineEvent) => void): void { this.listeners = this.listeners.filter((l) => l !== cb); }
  private emit(e: EngineEvent): void { for (const cb of this.listeners) cb(e); }

  enqueue(jobId: string): void {
    void this.processNext();
  }

  rerunFrom(jobId: string, step: StepId): void {
    this.opts.store.rerunFrom(jobId, step);
    this.enqueue(jobId);
  }

  async processNext(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(): Promise<void> {
    // 每轮快照跑完后重扫：drain 进行期间新入队的任务（并发 POST、运行中的 rerunFrom）
    // 不能被漏掉，否则会一直卡在 queued 直到下一次 enqueue。单飞语义不变——
    // busy 期间的 enqueue/rerunFrom 仍 join 在途 drain，由本循环兜底拾取。
    // 终止性：runJob 结束时任务必为 completed/failed/needs_review（不再 queued），
    // queued 只能由 createJob/rerunFrom 重新产生（调用方行为），不会自转死循环。
    for (;;) {
      const jobs = this.opts.store.listJobs(100).filter((j) => j.status === "queued");
      if (jobs.length === 0) return;
      for (const job of jobs) {
        await this.runJob(job.id);
      }
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const store = this.opts.store;
    const job = store.getJob(jobId);
    if (!job) return;
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
    const judge = hasCustom
      ? new Judge(llm, job.config.models.default, this.opts.services.judge.threshold)
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
      // 注入模型：步骤内通过 ctx.llm.chat({ model, ... }) 使用
      (ctx as StepContext & { _model: string })._model = model;
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

  shutdown(): void { /* no-op: 队列为惰性单飞 */ }
}
