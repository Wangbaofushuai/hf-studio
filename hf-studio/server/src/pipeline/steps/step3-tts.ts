import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult, Beat } from "../../types";
import { buildRealBoundaries, flattenTranscript, estimateSec } from "../beat-timing";
import { probeMedia } from "../../util/ffprobe";

export { estimateSec };

// 相邻 beat 之间的静默间隙（秒）：必须为 0。
// narration.wav 是各 beat 音频用 ffmpeg -c copy 无缝拼接（无静音插入），视频时间窗必须与其完全对齐；
// 若视频边界插入固定间隙，间隙处没有任何 beat 内容 → 渲染露出宿主黑底 → 片段切换处黑屏闪烁，
// 且视频时间轴比音频每段慢 gap（音画漂移）。早期用词级时间戳（偏短）才需要 gap 补偿，
// 现在边界来自 ffprobe 真实音频时长（不偏短），无需补偿。
const REAL_GAP_SEC = 0;

export const step3Tts: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const beats = (prev[2]?.data.storyboard as { beats: Beat[] } | undefined)?.beats ?? [];
  // probe 可注入（默认真实 ffprobe），测试时用固定值替代
  const probe: typeof probeMedia = (ctx as unknown as { _probeMedia?: typeof probeMedia })._probeMedia ?? probeMedia;
  if (!ctx.config.voiceover) {
    const boundaries = buildRealBoundaries(beats.map((b) => b.durationSec), 0);
    return {
      status: "passed",
      artifacts: [],
      data: { boundaries, audioDuration: boundaries.at(-1)?.endSec ?? 0, realTotalSec: boundaries.at(-1)?.endSec ?? 0 },
      log: `无配音模式：按分镜估算时长 ${boundaries.at(-1)?.endSec?.toFixed(1)}s`,
    };
  }

  mkdirSync(join(ctx.projectDir, "assets"), { recursive: true });
  const wordsPerBeat: { words: { text: string; start: number; end: number }[] }[] = [];
  const beatWavs: string[] = [];
  const realSecs: number[] = [];
  // 确定性时长估算：旁白字数 ÷ 语速（不依赖 LLM 的 durationSec 拍脑袋值）
  const totalEstimate = beats.reduce((s, b) => s + estimateSec(b.narration, ctx.config.language), 0);

  for (const beat of beats) {
    const wav = join(ctx.projectDir, "assets", `narration-beat-${beat.index}.wav`);
    const { words, durationSec } = await ctx.tts.synthesizeToWav(beat.narration, ctx.config.voice, wav);
    wordsPerBeat.push({ words });
    beatWavs.push(wav);
    // 写盘后 ffprobe 实测真实秒数（不再用 synthesizeToWav 返回的 durationSec 定边界）
    const real = await probe(wav);
    realSecs.push(real.durationSec);
    ctx.log(`beat ${beat.index} 配音 ${durationSec.toFixed(2)}s 实测 ${real.durationSec.toFixed(2)}s`);
  }

  // 真实时长边界：实测逐 beat 累计 + 间隙
  const boundaries = buildRealBoundaries(realSecs, REAL_GAP_SEC);
  const realTotalSec = boundaries.at(-1)?.endSec ?? 0;

  // 校验：真实总时长与脚本估算偏差 ≤ 30%
  if (realTotalSec <= 0) {
    return { status: "gate_failed", artifacts: [], data: {}, log: "配音产物为空", gateErrors: ["配音生成失败：音频时长为 0"] };
  }
  const dev = Math.abs(realTotalSec - totalEstimate) / totalEstimate;
  if (dev > 0.3) {
    return {
      status: "gate_failed", artifacts: [], data: {}, log: `配音时长 ${realTotalSec.toFixed(1)}s 与估算 ${totalEstimate.toFixed(1)}s 偏差 ${(dev * 100).toFixed(0)}% > 30%`,
      gateErrors: [`配音时长偏差超限：${realTotalSec.toFixed(1)}s vs 估算 ${totalEstimate.toFixed(1)}s`],
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

  // transcript（词级时间戳）继续生成用于字幕，但不再驱动边界
  const transcript = flattenTranscript(wordsPerBeat);
  writeFileSync(join(ctx.projectDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  return {
    status: "passed",
    artifacts: ["assets/narration.wav", "transcript.json"],
    data: { boundaries, transcript, realTotalSec, audioDuration: realTotalSec },
    log: `配音完成：${realTotalSec.toFixed(1)}s（实测），${wordsPerBeat.length} 个片段`,
  };
};
