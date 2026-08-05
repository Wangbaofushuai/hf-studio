export interface Boundary { index: number; startSec: number; endSec: number }

// 语速表：字符/秒（按旁白语言取，用于把旁白字数换算成预计配音时长）
const SPEECH_RATE: Record<string, number> = { zh: 4, ja: 5, en: 13 };
const DEFAULT_RATE = 8;

/** 旁白时长估算：纯文字数（剔除标点/空白）÷ 语速（确定性，不依赖 LLM 的 durationSec 拍脑袋值） */
export function estimateSec(narration: string, language: string): number {
  const langKey = Object.keys(SPEECH_RATE).find((k) => language.toLowerCase().startsWith(k)) ?? "";
  const rate = SPEECH_RATE[langKey] ?? DEFAULT_RATE;
  // 只数文字与数字：标点不算字数（否则旁白门会被"60 字符含 14 个标点 → 估算 15s"骗过，
  // 真实旁白只有 46 字 → 视频 10.3s vs 目标 15s——E2E 实测）
  const letters = narration.replace(/[^\p{L}\p{N}]/gu, "").length;
  return Math.max(letters / rate, 0.5);
}

export function buildBeatBoundaries(
  wordsPerBeat: { words: { text: string; start: number; end: number }[] }[],
  beats: { durationSec: number }[],
): Boundary[] {
  const boundaries: Boundary[] = [];
  let cursor = 0;
  if (wordsPerBeat.length === 0) {
    // 无配音：用估算时长，不归一化（估算总和已由 step2 校验）
    beats.forEach((b, i) => {
      boundaries.push({ index: i + 1, startSec: cursor, endSec: cursor + b.durationSec });
      cursor += b.durationSec;
    });
    return boundaries;
  }
  wordsPerBeat.forEach((seg, i) => {
    const last = seg.words[seg.words.length - 1];
    const end = last ? last.end : 0;
    boundaries.push({ index: i + 1, startSec: cursor, endSec: cursor + end });
    cursor += end;
  });
  return boundaries;
}

/** 真实时长边界：把 ffprobe 实测的各 beat 秒数逐段累加，并插入固定间隙。
 *  区别于 buildBeatBoundaries（词级时间戳末尾，偏短），这里用真实音频时长，
 *  保证"视频比配音先结束"不再发生。单元素（最后一 beat）不追加尾间隙。 */
export function buildRealBoundaries(realSecs: number[], gapSec: number): Boundary[] {
  const boundaries: Boundary[] = [];
  let cursor = 0;
  realSecs.forEach((sec, i) => {
    boundaries.push({ index: i + 1, startSec: cursor, endSec: cursor + sec });
    cursor += sec + (i < realSecs.length - 1 ? gapSec : 0);
  });
  return boundaries;
}

export function flattenTranscript(
  wordsPerBeat: { words: { text: string; start: number; end: number }[] }[],
): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let cursor = 0;
  for (const seg of wordsPerBeat) {
    for (const w of seg.words) {
      out.push({ text: w.text, start: cursor + w.start, end: cursor + w.end });
    }
    cursor += seg.words.length > 0 ? seg.words[seg.words.length - 1].end : 0;
  }
  return out;
}
