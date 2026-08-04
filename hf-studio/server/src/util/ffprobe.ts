import { execFileSync } from "node:child_process";

export async function probeMedia(path: string): Promise<{ durationSec: number; hasVideo: boolean; hasAudio: boolean }> {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", path],
    { maxBuffer: 4 * 1024 * 1024 },
  ).toString("utf8");
  const parsed = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
  const durationSec = Number(parsed.format?.duration ?? 0);
  const streams = parsed.streams ?? [];
  return {
    durationSec,
    hasVideo: streams.some((s) => s.codec_type === "video"),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}
