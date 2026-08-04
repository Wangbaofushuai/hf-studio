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
});
