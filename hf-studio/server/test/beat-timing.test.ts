import { describe, expect, test } from "bun:test";
import { buildBeatBoundaries, buildRealBoundaries } from "../src/pipeline/beat-timing";

describe("buildBeatBoundaries", () => {
  test("voiceover: boundaries are cumulative audio durations", () => {
    const wordsPerBeat = [
      { words: [{ text: "a", start: 0, end: 1 }] },
      { words: [{ text: "b", start: 0, end: 2 }] },
    ];
    const beats = [{ durationSec: 5 }, { durationSec: 5 }];
    const b = buildBeatBoundaries(wordsPerBeat, beats);
    expect(b).toEqual([
      { index: 1, startSec: 0, endSec: 1 },
      { index: 2, startSec: 1, endSec: 3 },
    ]);
  });

  test("no voiceover: boundaries use estimated durations (not normalized)", () => {
    const b = buildBeatBoundaries([], [{ durationSec: 2 }, { durationSec: 8 }]);
    expect(b).toEqual([
      { index: 1, startSec: 0, endSec: 2 },
      { index: 2, startSec: 2, endSec: 10 },
    ]);
  });
});

describe("buildRealBoundaries", () => {
  test("real durations are cumulative with fixed gaps, no trailing gap", () => {
    const b = buildRealBoundaries([3, 5, 2], 0.25);
    expect(b).toEqual([
      { index: 1, startSec: 0, endSec: 3 },
      { index: 2, startSec: 3.25, endSec: 8.25 },
      { index: 3, startSec: 8.5, endSec: 10.5 },
    ]);
    expect(b.map((x) => x.endSec)).toEqual([3, 8.25, 10.5]); // 末段不追加尾间隙（10.5 = 8.5+2）
  });

  test("single element has no trailing gap", () => {
    expect(buildRealBoundaries([4], 0.25)).toEqual([
      { index: 1, startSec: 0, endSec: 4 },
    ]);
  });

  test("zero gap yields contiguous boundaries", () => {
    expect(buildRealBoundaries([2, 8], 0)).toEqual([
      { index: 1, startSec: 0, endSec: 2 },
      { index: 2, startSec: 2, endSec: 10 },
    ]);
  });
});
