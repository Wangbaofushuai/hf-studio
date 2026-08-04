import { useParams } from "react-router-dom";

// 占位页：任务详情由 Task 16 实现（getJob + SSE 进度 + 产物预览 + 干预按钮）
export default function JobDetail() {
  const { id } = useParams();
  return (
    <div>
      <h2 className="text-xl font-semibold">任务详情</h2>
      <p className="mt-4 text-sm text-neutral-500">任务 {id} 的详情页将在后续迭代中提供（Task 16）。</p>
    </div>
  );
}
