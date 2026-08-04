export interface Boundary { index: number; startSec: number; endSec: number }

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
