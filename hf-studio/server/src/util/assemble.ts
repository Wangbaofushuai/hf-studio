// server/src/util/assemble.ts —— 分镜片段归一化拼接（jimeng 直出成片）
// 步骤：逐片段归一化（分辨率/帧率/时长对齐 beat 窗口，短片段 tpad 补帧、apad 补静音）
//       → concat demuxer 拼接 → 需要时混入旁白 → 输出 mp4
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { probeMedia } from "./ffprobe";

const execFileP = promisify(execFile);

export interface AssembleBeat {
  clipAbsPath: string;
  durationSec: number; // beat 窗口（秒）
}

export interface AssembleOptions {
  workDir: string;              // 归一化中间产物目录（绝对）
  beats: AssembleBeat[];
  outPath: string;              // 最终输出（绝对）
  narrationWav?: string | null; // 有旁白时混入
  duckOriginalVolume?: number;  // 片段原声压低音量（默认 0.2；旁白开启时生效）
  fps?: number;                 // 默认 30
}

/** 归一化参数（视频：缩放/补边/补帧；音频：音量/补静音；严格裁剪到窗口时长） */
export function buildNormalizeArgs(opts: {
  clipAbsPath: string;
  outPath: string;
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
  volume: number;
  fps: number;
}): string[] {
  const { clipAbsPath, outPath, width, height, durationSec, hasAudio, volume, fps } = opts;
  const vf = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${fps}`,
    `tpad=stop_mode=clone:stop_duration=${durationSec}`,
  ].join(",");
  const args = ["-y", "-i", clipAbsPath];
  if (hasAudio) {
    args.push("-map", "0:v:0", "-map", "0:a:0");
  } else {
    // 无音轨片段：补一路静音
    args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", "1:a:0");
  }
  args.push(
    "-vf", vf,
    "-af", hasAudio
      ? `volume=${volume},aresample=48000,apad,atrim=0:${durationSec}`
      : `aresample=48000,apad,atrim=0:${durationSec}`,
    "-t", String(durationSec),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    outPath,
  );
  return args;
}

/** concat demuxer 清单文件内容 */
export function buildConcatList(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/** 旁白混音参数（旁白与已压低的分镜原声混合，时长以视频为准） */
export function buildMixArgs(concatPath: string, narrationWav: string, outPath: string): string[] {
  return [
    "-y", "-i", concatPath, "-i", narrationWav,
    "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]",
    "-map", "0:v:0", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    outPath,
  ];
}

/** 执行归一化 + 拼接（+ 可选旁白混音），返回最终输出路径 */
export async function assembleBeats(opts: AssembleOptions): Promise<void> {
  const fps = opts.fps ?? 30;
  const duck = opts.duckOriginalVolume ?? 0.2;
  const first = await probeMedia(opts.beats[0].clipAbsPath);
  if (!first.hasVideo || first.width <= 0 || first.height <= 0) {
    throw new Error(`首片段无有效视频流：${opts.beats[0].clipAbsPath}`);
  }
  const normalized: string[] = [];
  for (let i = 0; i < opts.beats.length; i++) {
    const b = opts.beats[i];
    if (!existsSync(b.clipAbsPath)) throw new Error(`片段缺失：${b.clipAbsPath}`);
    const probe = await probeMedia(b.clipAbsPath);
    const out = `${opts.workDir}/norm-${String(i + 1).padStart(2, "0")}.mp4`;
    const args = buildNormalizeArgs({
      clipAbsPath: b.clipAbsPath,
      outPath: out,
      width: first.width,
      height: first.height,
      durationSec: b.durationSec,
      hasAudio: probe.hasAudio,
      volume: opts.narrationWav ? duck : 1,
      fps,
    });
    await execFileP("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024 });
    normalized.push(out);
  }
  const listPath = `${opts.workDir}/concat.txt`;
  writeFileSync(listPath, buildConcatList(normalized));
  const concatOut = `${opts.workDir}/concat.mp4`;
  await execFileP("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", concatOut], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (opts.narrationWav && existsSync(opts.narrationWav)) {
    await execFileP("ffmpeg", buildMixArgs(concatOut, opts.narrationWav, opts.outPath), {
      maxBuffer: 64 * 1024 * 1024,
    });
  } else {
    await execFileP("ffmpeg", ["-y", "-i", concatOut, "-c", "copy", "-movflags", "+faststart", opts.outPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }
}
