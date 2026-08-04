export interface Boundary { index: number; startSec: number; endSec: number }

// 语速表：字符/秒（按旁白语言取，用于把旁白字数换算成预计配音时长）
const SPEECH_RATE: Record<string, number> = { zh: 4, ja: 5, en: 13 };
const DEFAULT_RATE = 8;

/** 旁白时长估算：字数 ÷ 语速（确定性，不依赖 LLM 的 durationSec 拍脑袋值） */
export function estimateSec(narration: string, language: string): number {
  const langKey = Object.keys(SPEECH_RATE).find((k) => language.toLowerCase().startsWith(k)) ?? "";
  const rate = SPEECH_RATE[langKey] ?? DEFAULT_RATE;
  return Math.max(narration.trim().length / rate, 0.5);
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
