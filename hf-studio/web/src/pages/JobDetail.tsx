import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { getJob, rerunJob, subscribeJob, fetchBeats } from "../api";
import type { JobDetailDto } from "../types";
import ProgressSteps from "../components/ProgressSteps";
import ArtifactPanel from "../components/ArtifactPanel";

const STATUS_LABEL: Record<string, string> = { queued: "排队中", running: "生成中", failed: "失败", needs_review: "待人工处理", completed: "完成" };
const FORMAT_LABEL: Record<string, string> = {
  landscape: "横屏 16:9 · 1920×1080",
  portrait: "竖屏 9:16 · 1080×1920",
  square: "方形 1:1 · 1080×1080",
};

export default function JobDetail() {
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<JobDetailDto | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [beats, setBeats] = useState<{ index: number; file: string; size: number; mtime: string; desc: string }[]>([]);
  const esRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    getJob(id).then(setDetail).catch(() => {});
    esRef.current = subscribeJob(id, (e) => {
      const ev = e as { type?: string; jobId?: string; status?: string; log?: string; message?: string };
      if (ev.type === "job_status" && ev.message) setLogs((l) => [...l.slice(-49), ev.message!]);
      getJob(id).then(setDetail).catch(() => {});
    });
    return () => esRef.current?.();
  }, [id]);

  // 片段级构建进度：第 4/5 步期间轮询 /beats
  useEffect(() => {
    const step = detail?.job.currentStep;
    if (step !== 4 && step !== 5) return;
    const t = setInterval(() => fetchBeats(id).then((r) => setBeats(r.beats)).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [detail?.job.currentStep, id]);

  const onRerun = async (step: number) => {
    if (!confirm(`重新生成第 ${step + 1} 步？后续步骤将重新执行。`)) return;
    // 可选换模型：留空保持当前模型
    const override = window.prompt("可选：输入要切换的模型（如 deepseek/deepseek-chat），留空保持当前模型");
    if (override === null) return;
    await rerunJob(id, step, override.trim() || undefined);
    setLogs((l) => [...l, `已提交重新生成第 ${step + 1} 步${override.trim() ? `（模型：${override.trim()}）` : ""}`]);
    getJob(id).then(setDetail).catch(() => {});
  };

  if (!detail) return <p className="text-sm text-neutral-500">加载中…</p>;
  const { job, steps } = detail;
  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-semibold tracking-tight">{job.config.idea}</h2>
          <p className="mt-1 text-xs text-neutral-400">
            {STATUS_LABEL[job.status] ?? job.status}{job.error ? ` · ${job.error}` : ""} · 创建于 {new Date(job.createdAt).toLocaleString("zh-CN")}
          </p>
        </div>
      </header>

      <div className="glass p-4">
        <ProgressSteps steps={steps} currentStep={job.currentStep} />
          {beats.length > 0 && (
            <section className="glass p-5">
              <h3 className="mb-3 text-sm font-semibold text-neutral-600 dark:text-neutral-300">片段构建进度</h3>
              <ul className="space-y-2">
                {beats.map((b) => (
                  <li key={b.file} className="flex items-center gap-3 text-sm">
                    <span className="w-16 shrink-0 font-mono text-xs text-neutral-500">片段 {b.index}</span>
                    <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-300">{b.desc || b.file}</span>
                    <span className={`shrink-0 text-xs ${b.size === 0 ? "text-amber-500" : "text-green-600 dark:text-green-400"}`}>
                      {b.size === 0 ? "生成中…" : `已完成 ${(b.size / 1024).toFixed(1)}KB`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
      </div>

      <section className="glass p-5">
        <h3 className="mb-3 text-sm font-semibold">任务配置</h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex gap-2">
            <dt className="shrink-0 text-neutral-500">格式</dt>
            <dd className="min-w-0 text-neutral-700 dark:text-neutral-300">{FORMAT_LABEL[job.config.format] ?? job.config.format}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-neutral-500">时长</dt>
            <dd className="min-w-0 text-neutral-700 dark:text-neutral-300">{job.config.durationSec} 秒</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-neutral-500">清晰度</dt>
            <dd className="min-w-0 text-neutral-700 dark:text-neutral-300">{job.config.renderQuality === "hd" ? "高清" : job.config.renderQuality === "standard" ? "标准" : "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-neutral-500">字幕</dt>
            <dd className="min-w-0 text-neutral-700 dark:text-neutral-300">{job.config.subtitles === false ? "关闭" : "开启"}</dd>
          </div>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
            <dt className="shrink-0 text-neutral-500">主题</dt>
            <dd className="min-w-0 text-neutral-700 dark:text-neutral-300">
              {job.config.theme ? (
                <span className="flex flex-wrap items-center gap-2">
                  {job.config.theme.id}
                  {job.config.theme.hue?.primary && <span className="h-4 w-4 rounded-full border border-black/20" style={{ background: job.config.theme.hue.primary }} />}
                  {job.config.theme.hue?.accent && <span className="h-4 w-4 rounded-full border border-black/20" style={{ background: job.config.theme.hue.accent }} />}
                </span>
              ) : "自由发挥"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="glass p-5">
        <h3 className="mb-3 text-sm font-semibold">步骤时间线</h3>
        <ul className="space-y-2">
          {steps.map((s) => (
            <li key={s.step} className="rounded-xl border border-black/[0.06] bg-white/50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">{s.log}</span>
                <button onClick={() => onRerun(s.step)} className="btn-secondary shrink-0 !px-3 !py-1 text-xs">重新生成此步</button>
              </div>
              {s.error && <p className="mt-1 text-xs text-red-500">{s.error}</p>}
              {s.judge && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">评审 {s.judge.score} 分：{s.judge.feedback}</p>}
            </li>
          ))}
          {steps.length === 0 && <li className="text-sm text-neutral-500">等待执行…</li>}
        </ul>
      </section>

      <section className="glass p-5">
        <ArtifactPanel jobId={id} steps={steps} />
      </section>

      {logs.length > 0 && (
        <section className="glass p-5">
          <h3 className="mb-2 text-sm font-semibold">实时日志</h3>
          <pre className="max-h-48 overflow-auto rounded-xl bg-black/[0.04] p-3 text-xs text-neutral-500 dark:bg-black/40 dark:text-neutral-400">{logs.join("\n")}</pre>
        </section>
      )}
    </div>
  );
}
