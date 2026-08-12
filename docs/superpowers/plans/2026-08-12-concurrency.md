# 并发/队列优化（固定并发 worker 池）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PipelineEngine 由单飞串行 drain 改为固定并发 worker 池，最多同时执行 `maxConcurrency` 个任务，FIFO 出队，事件/API 不变。

**Architecture:** engine 维护 `active: Map<jobId, Promise>` + 幂等 `schedule()`；入队/rerun/任务结束触发补位。`processNext()` 变 join 在途任务。新增 store `listQueued()` 提供确定性 FIFO（rowid ASC）。生产默认并发 2（`HF_STUDIO_CONCURRENCY` 可调）。

**Tech Stack:** TypeScript + bun + bun:sqlite + bun:test

## Global Constraints

- 遵循 spec：`docs/superpowers/specs/2026-08-12-concurrency-design.md`
- 生产默认并发 **2**（`HF_STUDIO_CONCURRENCY` 环境变量可调，钳制 ≥1）；engine 构造 `maxConcurrency` 默认 **2**
- FIFO：按入队顺序（rowid ASC）取 queued 任务
- 事件流（job_status / step_status）与 API 签名**不变**；`enqueue`/`rerunFrom`/`processNext`/`onEvent`/`offEvent` 保持可用
- 重启恢复语义不变（queued/running → failed）
- 提交：小步原子，`feat:` / `test:` 前缀

---

### Task 1: store 新增 `listQueued()`（确定性 FIFO）

**Files:**
- Modify: `server/src/db/store.ts`（`listJobs` 后加方法）
- Test: `server/test/store.test.ts`

**Interfaces:**
- Produces: `listQueued(): JobRow[]` — queued 任务按插入顺序（rowid ASC，最早入队在前）

- [ ] **Step 1: 写失败测试**

`server/test/store.test.ts` 追加：

```ts
test("listQueued returns queued jobs in insertion order (FIFO)", () => {
  const id1 = store.createJob(cfg);
  const id2 = store.createJob(cfg);
  const id3 = store.createJob(cfg);
  store.updateJob(id2, { status: "running" }); // 排除非 queued
  const q = store.listQueued();
  expect(q.map((j) => j.id)).toEqual([id1, id3]);
});
```

（若 store.test.ts 无现成 `store`/`cfg`，参照该文件已有的 beforeAll 模式建 `const store = new JobStore(join(dir, "jobs.db")); store.init();` 与 `cfg`。）

- [ ] **Step 2: 运行确认失败**

Run: `cd server && bun test test/store.test.ts --timeout 60000`
Expected: FAIL（`store.listQueued is not a function`）

- [ ] **Step 3: 实现**

`server/src/db/store.ts` 在 `listJobs` 方法后加：

```ts
  /** FIFO 队列快照：queued 任务按插入顺序（rowid ASC = 最早入队在前） */
  listQueued(): JobRow[] {
    const rows = this.db.query("SELECT * FROM jobs WHERE status = 'queued' ORDER BY rowid ASC").all() as Record<string, unknown>[];
    return rows.map((r) => this.mapJob(r));
  }
```

- [ ] **Step 4: 运行确认通过**

Run: `cd server && bun test test/store.test.ts --timeout 60000`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src/db/store.ts server/test/store.test.ts
git commit -m "feat: add store.listQueued for FIFO scheduling"
```

---

### Task 2: engine 改固定并发 worker 池

**Files:**
- Modify: `server/src/pipeline/engine.ts`（drain 串行 → worker 池）
- Modify: `server/test/engine.test.ts:112-145`（drain-rescan 用例改 `maxConcurrency: 1` 保持串行语义）
- Create: `server/test/engine-concurrency.test.ts`

**Interfaces:**
- Consumes: `store.listQueued()`（Task 1）
- Produces:
  - `PipelineEngine` 构造 opts 增 `maxConcurrency?: number`（默认 2，钳制 ≥1）
  - `enqueue(jobId)` / `rerunFrom(jobId, step)` / `processNext(): Promise<void>` / `onEvent` / `offEvent` 签名不变
  - `processNext()`：触发调度并等待**所有**在途任务结束（循环 join 直到无 queued 且无 active）

- [ ] **Step 1: 改 drain-rescan 用例为串行（写测试）**

`server/test/engine.test.ts:125` 的 engine 构造加 `maxConcurrency: 1`：

```ts
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir, maxConcurrency: 1 });
```

（该用例断言严格串行顺序 `["s0:rerunId","s1:rerunId","s0:slowId","s1:slowId","s1:rerunId"]`，并发下会乱序——显式退化为串行。）

新建 `server/test/engine-concurrency.test.ts`：

```ts
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/db/store";
import { PipelineEngine, type Services } from "../src/pipeline/engine";
import type { JobConfig, StepFn } from "../src/types";

const cfg: JobConfig = {
  idea: "t", durationSec: 10, format: "landscape", voiceover: false,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "hf-conc-"));
  const store = new JobStore(join(dir, "jobs.db"));
  store.init();
  return { dir, store };
}

describe("PipelineEngine concurrency", () => {
  let dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  test("runs at most maxConcurrency jobs in parallel", async () => {
    const { dir, store } = newStore(); dirs.push(dir);
    let concurrent = 0; let peak = 0;
    const steps: StepFn[] = [async () => {
      concurrent++; peak = Math.max(peak, concurrent);
      await sleep(30);
      concurrent--;
      return { status: "passed", artifacts: [], data: {}, log: "ok" };
    }];
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir, maxConcurrency: 2 });
    const ids = [store.createJob(cfg), store.createJob(cfg), store.createJob(cfg)];
    await engine.processNext();
    expect(peak).toBe(2);
    for (const id of ids) expect(store.getJob(id)?.status).toBe("completed");
  });

  test("processes queued jobs in FIFO order", async () => {
    const { dir, store } = newStore(); dirs.push(dir);
    const order: string[] = [];
    const steps: StepFn[] = [async (ctx) => {
      order.push(ctx.jobId);
      await sleep(10);
      return { status: "passed", artifacts: [], data: {}, log: "ok" };
    }];
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir, maxConcurrency: 1 });
    const a = store.createJob(cfg); const b = store.createJob(cfg); const c = store.createJob(cfg);
    await engine.processNext();
    expect(order).toEqual([a, b, c]);
  });

  test("mid-run enqueue and rerun are picked up after slots free", async () => {
    const { dir, store } = newStore(); dirs.push(dir);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let slowId = "";
    const steps: StepFn[] = [
      async (ctx) => {
        order.push(`s0:${ctx.jobId}`);
        if (ctx.jobId === slowId) await gate;
        return { status: "passed", artifacts: [], data: {}, log: "ok" };
      },
      async (ctx) => { order.push(`s1:${ctx.jobId}`); return { status: "passed", artifacts: [], data: {}, log: "ok" }; },
    ];
    const engine = new PipelineEngine({ store, steps, services: { render: () => ({}) } as unknown as Services, projectRoot: dir, maxConcurrency: 1 });
    const rerunId = store.createJob(cfg);
    await engine.processNext(); // rerunId 完整跑完
    slowId = store.createJob(cfg);
    const drain = engine.processNext(); // 慢任务占住唯一槽位
    engine.rerunFrom(rerunId, 1);       // 入队，等待补位
    release();
    await drain;
    expect(store.getJob(slowId)?.status).toBe("completed");
    expect(store.getJob(rerunId)?.status).toBe("completed");
    expect(order).toEqual(["s0:" + rerunId, "s1:" + rerunId, "s0:" + slowId, "s1:" + slowId, "s1:" + rerunId]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && bun test test/engine.test.ts test/engine-concurrency.test.ts --timeout 60000`
Expected: engine-concurrency 失败（并发上限不生效/`processNext` 语义变化）；drain-rescan 用例需确认现状是否绿（改 maxConcurrency 前它已绿，改后仍应绿）

- [ ] **Step 3: 实现 worker 池**

`server/src/pipeline/engine.ts` 整体替换为：

```ts
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

  /** 补位调度：有 queued 任务且有空闲槽位 → 按 FIFO 取出执行（幂等，可被入队/rerun/任务结束反复触发） */
  private schedule(): void {
    while (this.active.size < this.maxConcurrency) {
      const next = this.opts.store.listQueued()[0];
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
    const projectDir = join(this.opts.projectRoot, jobId);
    mkdirSync(projectDir, { recursive: true });
    const render = this.opts.services.render(projectDir);
    if ("initProject" in render) {
      await render.initProject(jobId, job.config.format);
    }
    this.emit({ type: "job_status", jobId, status: "running", currentStep: job.currentStep, message: "started" });

    const providers = mergeProviders(this.opts.services.baseProviders ?? [], job.config.providers);
    const hasCustom = (job.config.providers?.length ?? 0) > 0;
    const llm = hasCustom ? new LlmGateway(providers) : this.opts.services.llm;
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
```

- [ ] **Step 4: 运行确认通过**

Run: `cd server && bun test test/engine.test.ts test/engine-concurrency.test.ts --timeout 60000`
Expected: 全绿（旧引擎 6 用例 + 新并发 3 用例；drain-rescan 用例在 maxConcurrency:1 下保持原顺序断言）

- [ ] **Step 5: 全量服务端验证**

Run: `cd server && bun test --timeout 60000 && tsc --noEmit`
Expected: 全绿、无类型错误

- [ ] **Step 6: 提交**

```bash
git add server/src/pipeline/engine.ts server/test/engine.test.ts server/test/engine-concurrency.test.ts
git commit -m "feat: fixed-concurrency worker pool scheduler"
```

---

### Task 3: 生产接线（HF_STUDIO_CONCURRENCY）

**Files:**
- Modify: `server/src/index.ts`（buildEngine 读环境变量）

- [ ] **Step 1: 实现**

`server/src/index.ts` 的 `buildEngine` 改为：

```ts
export function buildEngine(store: JobStore = createStore(), config: AppConfig = loadConfig()): PipelineEngine {
  const providers = mergedProviders(config);
  const services = {
    llm: new LlmGateway(providers),
    judge: new Judge(new LlmGateway(providers), config.defaults.judgeModel, config.defaults.judgeThreshold),
    judgeModel: config.defaults.judgeModel,
    baseProviders: providers,
    render: (projectDir: string) => new RenderService(projectDir),
    tts: new TtsService(),
  };
  // 并发上限：HF_STUDIO_CONCURRENCY（默认 2，钳制 ≥1）；4 核 7.8G 下 2 个渲染并行是安全值
  const maxConcurrency = Math.max(1, Number(process.env.HF_STUDIO_CONCURRENCY ?? 2) || 2);
  return new PipelineEngine({ store, steps, services, projectRoot: PROJECTS_ROOT, maxConcurrency });
}
```

- [ ] **Step 2: 验证编译**

Run: `cd server && tsc --noEmit && bun test --timeout 60000`
Expected: 全绿、无类型错误

- [ ] **Step 3: 提交**

```bash
git add server/src/index.ts
git commit -m "feat: read HF_STUDIO_CONCURRENCY for engine worker pool"
```

---

### Task 4: 收尾

- [ ] **Step 1: 全量测试**

Run: `cd server && bun test --timeout 60000 && tsc --noEmit`
Expected: 全绿

- [ ] **Step 2: 冒烟（可选，需真实 key + 约 14 分钟）**

Run: `cd server && bun run e2e`
Expected: 7 步全绿

- [ ] **Step 3: 更新 AGENTS.md（并发配置说明）**

在 AGENTS.md「服务、配置与数据」的 **端口** 行后加：

```
- **并发**：engine 固定并发 worker 池，默认 2（`HF_STUDIO_CONCURRENCY` 环境变量可调，钳制 ≥1）；FIFO 出队
```

```bash
git add AGENTS.md && git commit -m "docs: document HF_STUDIO_CONCURRENCY in AGENTS.md"
```
