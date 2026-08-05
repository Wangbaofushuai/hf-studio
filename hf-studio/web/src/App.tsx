import { NavLink, Routes, Route } from "react-router-dom";
import NewJob from "./pages/NewJob";
import JobList from "./pages/JobList";
import JobDetail from "./pages/JobDetail";
import Channels from "./pages/Channels";

const NAV = [
  { to: "/", label: "新建任务", end: true },
  { to: "/jobs", label: "任务列表", end: false },
  { to: "/channels", label: "模型渠道", end: false },
];

function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-10 flex w-60 flex-col gap-1 border-r border-black/10 bg-white/70 px-4 py-6 backdrop-blur-2xl dark:border-white/10 dark:bg-white/[0.04]">
      <div className="px-3 pb-6">
        <h1 className="text-xl font-semibold tracking-tight">HF-Studio</h1>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">视频生成中台</p>
      </div>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          className={({ isActive }) =>
            `rounded-xl px-3 py-2 text-sm transition-colors ${
              isActive
                ? "bg-black/[0.06] font-medium dark:bg-white/10"
                : "text-neutral-600 hover:bg-black/[0.04] dark:text-neutral-300 dark:hover:bg-white/[0.06]"
            }`
          }
        >
          {n.label}
        </NavLink>
      ))}
      <div className="mt-auto px-3 text-[11px] text-neutral-400 dark:text-neutral-500">
        v0.7 · 图文解说
      </div>
    </aside>
  );
}

export default function App() {
  return (
    <div className="min-h-screen">
      <Sidebar />
      <main className="ml-60 px-10 py-10">
        <div className="mx-auto max-w-4xl">
          <Routes>
            <Route path="/" element={<NewJob />} />
            <Route path="/jobs" element={<JobList />} />
            <Route path="/jobs/:id" element={<JobDetail />} />
            <Route path="/channels" element={<Channels />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
