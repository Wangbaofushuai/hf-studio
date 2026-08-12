# 并发/队列优化（固定并发 worker 池）设计文档

> 日期：2026-08-12
> 状态：已确认（用户逐节评审通过：固定并发数 / 默认 2 / FIFO）
> 范围：PipelineEngine 由单飞串行改为固定并发 worker 池，提升任务吞吐

## 1. 背景与决策

当前 engine 单队列串行（`drain` 逐个 `runJob`），本机渲染资源有限时先保稳定是合理的；但 LLM/TTS 阶段是 IO 密集（空闲等网络），串行让整体吞吐受限。改为固定并发后，多个任务可并行推进，渲染阶段仍受并发上限保护。

| 决策点 | 结果 |
|--------|------|
| 调度策略 | **固定并发数 worker 池**（不按阶段、不自适应） |
| 默认并发 | **2**（4 核 / 7.8G 内存：每渲染任务约 1-2 核 + 1-2G，2 个并行安全） |
| 配置 | 环境变量 `HF_STUDIO_CONCURRENCY`（或 config），默认 2 |
| 出队顺序 | FIFO（createdAt 序） |
| 事件/API | job_status / step_status 事件流不变，前端无感知 |

## 2. 调度模型

- engine 维护：`activeJobs: Map<jobId, Promise>`、`maxConcurrency`、幂等 `schedule()`
- 调度时机：`enqueue`、`rerunFrom`、任一任务结束（成功/失败/needs_review）后
- 规则：有 queued 任务且 `activeJobs.size < maxConcurrency` → 按 FIFO 取出执行；任务结束回调再触发 `schedule()` 补位
- `processNext()` 语义保留：join 所有在途任务后返回（供测试与调用方 await）

## 3. 并发安全

- bun:sqlite 同步 API 在单线程 JS 中天然串行，多任务交替写同一连接安全，无需锁
- 每任务独立 projectDir / LLM 实例 / 事件流，无共享可变状态
- 重启恢复语义不变（queued / running → failed，needs_review 保留）

## 4. 测试

- 新增 engine 并发测试（mock steps 带 sleep）：
  - 并行上限：N 个任务同时最多跑 maxConcurrency 个
  - FIFO 顺序
  - 完成补位：跑完一个立即调度下一个
  - rerunFrom 并发入队
- 现有全部测试保持绿

## 5. 影响面

- 后端：`server/src/pipeline/engine.ts`（核心改造）、`server/src/index.ts` / config（读并发数）
- 测试：`test/engine.test.ts` 扩展
- API / 前端不动
