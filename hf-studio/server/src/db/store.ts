import { Database } from "bun:sqlite";
import type { JobConfig, JobStatus, StepId, StepOutput } from "../types";

export interface JobRow {
  id: string; status: JobStatus; currentStep: StepId | null;
  config: JobConfig; error: string | null; userId: string | null;
  createdAt: string; updatedAt: string;
}

export class JobStore {
  private db: Database;
  constructor(dbPath: string) { this.db = new Database(dbPath, { create: true }); }

  init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        current_step INTEGER,
        config TEXT NOT NULL,
        error TEXT,
        user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS step_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        status TEXT NOT NULL,
        artifacts TEXT NOT NULL,
        data TEXT NOT NULL,
        log TEXT NOT NULL,
        judge TEXT,
        error TEXT,
        attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createJob(config: JobConfig, userId: string | null = null): string {
    const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    this.db.run(
      "INSERT INTO jobs (id, status, current_step, config, error, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, "queued", null, JSON.stringify(config), null, userId, now, now],
    );
    return id;
  }

  getJob(jobId: string): JobRow | null {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown> | null;
    return row ? this.mapJob(row) : null;
  }

  listJobs(limit = 50): JobRow[] {
    // 同毫秒创建的任务 created_at 相同：以 rowid DESC（插入顺序倒序）作为确定性 tiebreak
    const rows = this.db.query("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapJob(r));
  }

  private mapJob(row: Record<string, unknown>): JobRow {
    return {
      id: String(row.id),
      status: row.status as JobStatus,
      currentStep: row.current_step as StepId | null,
      config: JSON.parse(String(row.config)),
      error: row.error as string | null,
      userId: row.user_id as string | null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  updateJob(jobId: string, patch: Partial<Pick<JobRow, "status" | "currentStep" | "error" | "config">>): void {
    const job = this.getJob(jobId);
    if (!job) return;
    // 显式传入的键（含 null）优先：error/currentStep 需要能被清空，不能用 ?? 兜底
    this.db.run(
      "UPDATE jobs SET status = ?, current_step = ?, error = ?, config = ?, updated_at = ? WHERE id = ?",
      [patch.status ?? job.status,
       ("currentStep" in patch ? patch.currentStep : job.currentStep) ?? null,
       ("error" in patch ? patch.error : job.error) ?? null,
       JSON.stringify(patch.config ?? job.config), new Date().toISOString(), jobId],
    );
  }

  beginStep(jobId: string, step: StepId): void {
    this.updateJob(jobId, { status: "running", currentStep: step, error: null });
  }

  finishStep(jobId: string, step: StepId, out: StepOutput): void {
    // 同一步多次尝试：先删旧记录，只保留最新一次
    this.db.run("DELETE FROM step_runs WHERE job_id = ? AND step = ?", [jobId, step]);
    this.db.run(
      `INSERT INTO step_runs (job_id, step, status, artifacts, data, log, judge, error, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [jobId, step, out.status, JSON.stringify(out.artifacts), JSON.stringify(out.data), out.log,
       out.judge ? JSON.stringify(out.judge) : null, out.error ?? null, out.attempts, new Date().toISOString()],
    );
  }

  getStepOutputs(jobId: string): StepOutput[] {
    const rows = this.db.query("SELECT * FROM step_runs WHERE job_id = ? ORDER BY step ASC, id ASC").all(jobId) as Record<string, unknown>[];
    return rows.map((r) => ({
      step: r.step as StepId,
      status: r.status as StepOutput["status"],
      artifacts: JSON.parse(String(r.artifacts)),
      data: JSON.parse(String(r.data)),
      log: String(r.log),
      judge: r.judge ? JSON.parse(String(r.judge)) : undefined,
      error: r.error as string | undefined,
      attempts: Number(r.attempts),
    }));
  }

  getLatestOutput(jobId: string, step: StepId): StepOutput | null {
    const row = this.db.query("SELECT * FROM step_runs WHERE job_id = ? AND step = ? ORDER BY id DESC LIMIT 1").get(jobId, step) as Record<string, unknown> | null;
    if (!row) return null;
    return this.getStepOutputs(jobId).find((o) => o.step === step && o.attempts === Number(row.attempts)) ?? null;
  }

  rerunFrom(jobId: string, step: StepId): void {
    this.db.run("DELETE FROM step_runs WHERE job_id = ? AND step >= ?", [jobId, step]);
    this.updateJob(jobId, { status: "queued", currentStep: step, error: null });
  }

  recover(): void {
    this.db.run("UPDATE jobs SET status = 'failed', error = 'server restarted', updated_at = ? WHERE status IN ('queued','running')", [new Date().toISOString()]);
  }
}
