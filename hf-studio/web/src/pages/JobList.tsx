import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listJobs } from "../api";
import type { JobDto } from "../types";

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中", running: "生成中", failed: "失败", needs_review: "待人工处理", completed: "完成",
};

export default function JobList() {
  const [jobs, setJobs] = useState<JobDto[]>([]);
  useEffect(() => { listJobs().then((r) => setJobs(r.jobs)).catch(() => {}); }, []);
  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">任务列表</h2>
      <ul className="space-y-2">
        {jobs.map((j) => (
          <li key={j.id}>
            <Link to={`/jobs/${j.id}`} className="flex items-center justify-between rounded-md border border-neutral-800 px-4 py-3 hover:border-neutral-600">
              <span className="truncate text-sm">{j.config.idea}</span>
              <span className="text-xs text-neutral-400">{STATUS_LABEL[j.status] ?? j.status} · {j.config.format} · {j.config.durationSec}s</span>
            </Link>
          </li>
        ))}
        {jobs.length === 0 && <li className="text-sm text-neutral-500">暂无任务</li>}
      </ul>
    </div>
  );
}
