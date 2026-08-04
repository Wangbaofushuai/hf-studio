import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { getJob, rerunJob, subscribeJob } from "../api";
import type { JobDetailDto } from "../types";
import ProgressSteps from "../components/ProgressSteps";
import ArtifactPanel from "../components/ArtifactPanel";

const STATUS_LABEL: Record<string, string> = { queued: "排队中", running: "生成中", failed: "失败", needs_review: "待人工处理", completed: "完成" };

export default function JobDetail() {
  const { id = "" } = useParams();
  const [detail, setDetail] = useState<JobDetailDto | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{job.config.idea}</h2>
          <p className="text-xs text-neutral-400">状态：{STATUS_LABEL[job.status] ?? job.status}{job.error ? ` · ${job.error}` : ""}</p>
        </div>
        <span className="text-xs text-neutral-500">创建于 {new Date(job.createdAt).toLocaleString("zh-CN")}</span>
      </div>

      <ProgressSteps steps={steps} currentStep={job.currentStep} />

      <div>
        <h3 className="text-sm font-semibold mb-2">步骤时间线</h3>
        <ul className="space-y-2">
          {steps.map((s) => (
            <li key={s.step} className="rounded-md border border-neutral-800 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm">第 {s.step + 1} 步 · {s.log}</span>
                <button onClick={() => onRerun(s.step)} className="rounded bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700">重新生成此步</button>
              </div>
              {s.error && <p className="mt-1 text-xs text-red-400">{s.error}</p>}
              {s.judge && <p className="mt-1 text-xs text-amber-400">评审 {s.judge.score} 分：{s.judge.feedback}</p>}
            </li>
          ))}
          {steps.length === 0 && <li className="text-sm text-neutral-500">等待执行…</li>}
        </ul>
      </div>

      <ArtifactPanel jobId={id} steps={steps} />

      {logs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">实时日志</h3>
          <pre className="max-h-48 overflow-auto rounded-md bg-neutral-900 p-3 text-xs text-neutral-400">{logs.join("\n")}</pre>
        </div>
      )}
    </div>
  );
}
