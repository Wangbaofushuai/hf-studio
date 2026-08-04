import type { StepOutputDto } from "../types";

const EXT_PREVIEW: Record<string, string> = { png: "image", jpg: "image", jpeg: "image", webp: "image", mp4: "video", wav: "audio", mp3: "audio" };

export default function ArtifactPanel({ jobId, steps }: { jobId: string; steps: StepOutputDto[] }) {
  const artifacts = steps.flatMap((s) => s.artifacts.map((a) => ({ a, step: s.step })));
  const md = artifacts.filter(({ a }) => a.endsWith(".md"));
  const imgs = artifacts.filter(({ a }) => EXT_PREVIEW[a.split(".").pop() ?? ""] === "image");
  const video = artifacts.find(({ a }) => a.endsWith(".mp4"));
  const audio = artifacts.find(({ a }) => a.endsWith(".wav") || a.endsWith(".mp3"));
  return (
    <div className="space-y-4">
      {video && (
        <div>
          <h3 className="text-sm font-semibold mb-1">成片</h3>
          <video src={`/api/jobs/${jobId}/files/${video.a}`} controls className="w-full max-h-96 rounded-md bg-black" />
        </div>
      )}
      {audio && <audio src={`/api/jobs/${jobId}/files/${audio.a}`} controls className="w-full" />}
      {imgs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-1">关键帧快照</h3>
          <div className="grid grid-cols-3 gap-2">
            {imgs.map(({ a }) => <img key={a} src={`/api/jobs/${jobId}/files/${a}`} className="rounded-md border border-neutral-800" />)}
          </div>
        </div>
      )}
      {md.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-1">分镜 / 设计文档</h3>
          {md.map(({ a }) => (
            <details key={a} className="mb-2">
              <summary className="cursor-pointer text-xs text-neutral-400">{a}</summary>
              <iframe src={`/api/jobs/${jobId}/files/${a}`} className="h-64 w-full rounded-md border border-neutral-800 bg-white" title={a} />
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
