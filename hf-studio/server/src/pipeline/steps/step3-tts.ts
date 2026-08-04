import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult, Beat } from "../../types";
import { buildBeatBoundaries, flattenTranscript, estimateSec } from "../beat-timing";

export { estimateSec };

export const step3Tts: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const beats = (prev[2]?.data.storyboard as { beats: Beat[] } | undefined)?.beats ?? [];
  if (!ctx.config.voiceover) {
    const boundaries = buildBeatBoundaries([], beats);
    return {
      status: "passed",
      artifacts: [],
      data: { boundaries, audioDuration: boundaries.at(-1)?.endSec ?? 0 },
      log: `无配音模式：按分镜估算时长 ${boundaries.at(-1)?.endSec?.toFixed(1)}s`,
    };
  }

  mkdirSync(join(ctx.projectDir, "assets"), { recursive: true });
  const wordsPerBeat: { words: { text: string; start: number; end: number }[] }[] = [];
  const beatWavs: string[] = [];
  // 确定性时长估算：旁白字数 ÷ 语速（不依赖 LLM 的 durationSec 拍脑袋值）
  const totalEstimate = beats.reduce((s, b) => s + estimateSec(b.narration, ctx.config.language), 0);

  for (const beat of beats) {
    const wav = join(ctx.projectDir, "assets", `narration-beat-${beat.index}.wav`);
    const { words, durationSec } = await ctx.tts.synthesizeToWav(beat.narration, ctx.config.voice, wav);
    wordsPerBeat.push({ words });
    beatWavs.push(wav);
    ctx.log(`beat ${beat.index} 配音 ${durationSec.toFixed(2)}s`);
  }

  // 校验：音频总时长与脚本估算偏差 ≤ 30%
  const audioDuration = buildBeatBoundaries(wordsPerBeat, beats).at(-1)?.endSec ?? 0;
  if (audioDuration <= 0) {
    return { status: "gate_failed", artifacts: [], data: {}, log: "配音产物为空", gateErrors: ["配音生成失败：音频时长为 0"] };
  }
  const dev = Math.abs(audioDuration - totalEstimate) / totalEstimate;
  if (dev > 0.3) {
    return {
      status: "gate_failed", artifacts: [], data: {}, log: `配音时长 ${audioDuration.toFixed(1)}s 与估算 ${totalEstimate.toFixed(1)}s 偏差 ${(dev * 100).toFixed(0)}% > 30%`,
      gateErrors: [`配音时长偏差超限：${audioDuration.toFixed(1)}s vs 估算 ${totalEstimate.toFixed(1)}s`],
    };
  }

  // 拼接 narration.wav（concat 协议文件）
  const listFile = join(ctx.projectDir, "assets", "concat.txt");
  writeFileSync(listFile, beatWavs.map((w) => `file '${w.replace(/'/g, "'\\''")}'`).join("\n"));
  const narrationWav = join(ctx.projectDir, "assets", "narration.wav");
  execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", narrationWav], { stdio: "pipe" });
  if (!existsSync(narrationWav)) {
    return { status: "gate_failed", artifacts: [], data: {}, log: "拼接失败", gateErrors: ["narration.wav 拼接失败"] };
  }

  const boundaries = buildBeatBoundaries(wordsPerBeat, beats);
  const transcript = flattenTranscript(wordsPerBeat);
  writeFileSync(join(ctx.projectDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  return {
    status: "passed",
    artifacts: ["assets/narration.wav", "transcript.json"],
    data: { boundaries, transcript, audioDuration },
    log: `配音完成：${audioDuration.toFixed(1)}s，${wordsPerBeat.length} 个片段`,
  };
};
