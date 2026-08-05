export default function WizardSteps({ steps, current, maxReached, onJump }: {
  steps: string[];
  current: number;
  maxReached: number;
  onJump: (i: number) => void;
}) {
  return (
    <ol className="flex items-center gap-1.5">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <button type="button" disabled={i > maxReached} onClick={() => onJump(i)}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors ${
                active ? "bg-[#0071e3] text-white" : done ? "text-[#0071e3] hover:bg-black/[0.04]" : i > maxReached ? "cursor-not-allowed text-neutral-300" : "text-neutral-500 hover:bg-black/[0.04]"
              }`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                active ? "bg-white/20" : done ? "bg-[#0071e3]/10" : "bg-black/[0.06]"
              }`}>{done ? "✓" : i + 1}</span>
              <span>{label}</span>
            </button>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />}
          </li>
        );
      })}
    </ol>
  );
}