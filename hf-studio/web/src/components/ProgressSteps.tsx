import type { StepOutputDto } from "../types";

const STEP_NAMES = ["需求解析", "创意设计", "分镜脚本", "配音", "构建", "验证", "渲染"];

export default function ProgressSteps({ steps, currentStep }: { steps: StepOutputDto[]; currentStep: number | null }) {
  return (
    <ol className="flex flex-wrap gap-2 text-xs">
      {STEP_NAMES.map((name, i) => {
        const out = steps.find((s) => s.step === i);
        const state = out ? (out.status === "passed" ? "done" : "failed") : currentStep === i ? "running" : "todo";
        const cls = state === "done" ? "bg-green-900/60 text-green-300" : state === "failed" ? "bg-red-900/60 text-red-300" : state === "running" ? "bg-blue-900/60 text-blue-300 animate-pulse" : "bg-neutral-800 text-neutral-500";
        return <li key={i} className={`rounded-md px-3 py-1.5 ${cls}`}>{i + 1}. {name}</li>;
      })}
    </ol>
  );
}
