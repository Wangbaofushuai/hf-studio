import { execFileSync } from "node:child_process";

export interface MediaProbe {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
}

export async function probeMedia(path: string): Promise<MediaProbe> {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-show_streams", "-of", "json", path],
    { maxBuffer: 4 * 1024 * 1024 },
  ).toString("utf8");
  const parsed = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const durationSec = Number(parsed.format?.duration ?? 0);
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  return {
    durationSec,
    hasVideo: Boolean(video),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
  };
}
