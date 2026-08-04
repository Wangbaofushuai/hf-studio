import { Routes, Route, Link } from "react-router-dom";
import NewJob from "./pages/NewJob";
import JobList from "./pages/JobList";
import JobDetail from "./pages/JobDetail";

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4 flex items-center gap-6">
        <h1 className="text-lg font-bold">HF-Studio</h1>
        <nav className="flex gap-4 text-sm text-neutral-400">
          <Link to="/" className="hover:text-white">新建任务</Link>
          <Link to="/jobs" className="hover:text-white">任务列表</Link>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Routes>
          <Route path="/" element={<NewJob />} />
          <Route path="/jobs" element={<JobList />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
        </Routes>
      </main>
    </div>
  );
}
