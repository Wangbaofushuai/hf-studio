import { describe, expect, test } from "bun:test";
import { buildBeatBoundaries } from "../src/pipeline/beat-timing";

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
