import { describe, expect, test } from "bun:test";
import { generateRootHtml } from "../src/pipeline/root-html";

describe("generateRootHtml", () => {
  const beats = [
    { id: "beat-1", startSec: 0, endSec: 4.2 },
    { id: "beat-2", startSec: 4.2, endSec: 9.0 },
  ];

  test("wires beat slots with cumulative timing", () => {
    const html = generateRootHtml({ beats, format: "landscape", totalSec: 9, voiceover: true, bgm: null, language: "zh-CN" });
    expect(html).toContain('data-composition-id="root"');
    expect(html).toContain('data-composition-src="compositions/beat-1.html"');
    expect(html).toContain('data-composition-src="compositions/beat-2.html"');
    expect(html).toContain('data-start="0" data-duration="4.2"');
    expect(html).toContain('data-start="4.2" data-duration="4.8"');
    expect(html).toContain('src="assets/narration.wav"');
    expect(html).toContain('__timelines["root"]');
  });

  test("portrait uses 1080x1920 and no narration when voiceover=false", () => {
    const html = generateRootHtml({ beats, format: "portrait", totalSec: 9, voiceover: false, bgm: null, language: "zh-CN" });
    expect(html).toContain("width=1080, height=1920");
    expect(html).not.toContain("narration.wav");
  });

  test("bgm audio element added with low volume", () => {
    const html = generateRootHtml({ beats, format: "square", totalSec: 9, voiceover: true, bgm: "assets/bgm.mp3", language: "zh-CN" });
    expect(html).toContain('src="assets/bgm.mp3"');
    expect(html).toContain('data-volume="0.2"');
  });

  test("slot durations derive from rounded start/end so adjacent slots never overlap", () => {
    // 分数边界（来自 transcript 词时间戳的真实形态）：独立舍入 start 与 duration 会产生
    // 10ms 错位重叠（如 2.08+3.89=5.97 vs 下一个槽位 start 5.96）→ lint overlapping_clips_same_track
    const frac = [
      { id: "beat-1", startSec: 0, endSec: 2.08333 },
      { id: "beat-2", startSec: 2.08333, endSec: 5.964 },
      { id: "beat-3", startSec: 5.964, endSec: 9.69 },
    ];
    const html = generateRootHtml({ beats: frac, format: "landscape", totalSec: 9.69, voiceover: false, bgm: null, language: "zh-CN" });
    expect(html).toContain('data-start="0" data-duration="2.08"');
    expect(html).toContain('data-start="2.08" data-duration="3.88"');   // 2.08+3.88=5.96 == 下一槽位 start
    expect(html).toContain('data-start="5.96" data-duration="3.73"');   // 5.96+3.73=9.69
  });
});
