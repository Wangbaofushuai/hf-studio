import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listJobs } from "../api";
import type { JobDto } from "../types";

const STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "排队中", cls: "bg-neutral-500/10 text-neutral-500" },
  running: { label: "生成中", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  failed: { label: "失败", cls: "bg-red-500/10 text-red-500" },
  needs_review: { label: "待人工处理", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  completed: { label: "完成", cls: "bg-green-500/10 text-green-600 dark:text-green-400" },
};

export default function JobList() {
  const [jobs, setJobs] = useState<JobDto[]>([]);
  useEffect(() => { listJobs().then((r) => setJobs(r.jobs)).catch(() => {}); }, []);
  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">任务列表</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">共 {jobs.length} 个任务</p>
      </header>
      <ul className="space-y-3">
        {jobs.map((j) => {
          const st = STATUS[j.status] ?? { label: j.status, cls: "bg-neutral-500/10" };
          return (
            <li key={j.id}>
              <Link to={`/jobs/${j.id}`} className="glass flex items-center justify-between gap-4 p-4 transition-all hover:shadow-xl hover:shadow-black/[0.06]">
                <div className="min-w-0">
                  <p className="truncate font-medium">{j.config.idea}</p>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    {j.config.format} · {j.config.durationSec}s · {new Date(j.createdAt).toLocaleString("zh-CN")}
                  </p>
                </div>
                <span className={`badge shrink-0 ${st.cls}`}>{st.label}</span>
              </Link>
            </li>
          );
        })}
        {jobs.length === 0 && (
          <li className="glass p-10 text-center text-sm text-neutral-500">
            暂无任务<br />
            <Link to="/" className="mt-3 inline-block text-[#0071e3]">去创建第一个视频 →</Link>
          </li>
        )}
      </ul>
    </div>
  );
}
