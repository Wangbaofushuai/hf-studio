import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step3Tts } from "../src/pipeline/steps/step3-tts";
import type { StepContext, JobConfig, StepOutput } from "../src/types";

const cfg: JobConfig = {
  idea: "t", durationSec: 15, format: "landscape", voiceover: true,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};

// 最小合法 WAV：16-bit 单声道 PCM 24kHz，480 个静音采样（20ms），44 字节头 + 960 字节数据
const fakeWav = (() => {
  const dataSize = 480 * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24); buf.writeUInt32LE(24000 * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
  return buf;
})();

describe("step3Tts", () => {
  test("voiceover: synthesizes per beat, concatenates, writes transcript.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step3-"));
    const prev: StepOutput[] = [
      { step: 0, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 1, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
      {
        step: 2, status: "passed", artifacts: [], data: {
          storyboard: { beats: [
            { index: 1, id: "beat-1", title: "a", narration: "第一句", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 0.9 },
            { index: 2, id: "beat-2", title: "b", narration: "第二句", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 1.1 },
          ] },
        }, log: "", attempts: 1,
      },
    ];
    const tts = {
      synthesizeToWav: async (text: string, _voice: string, outWav: string) => {
        // 假合成：写一个最小合法 wav（16-bit 单声道 PCM 24kHz，20ms 静音，
        // ffmpeg concat -c copy 可解析拼接）+ 返回固定时间戳
        (await import("node:fs")).writeFileSync(outWav, fakeWav);
        return text === "第一句"
          ? { words: [{ text: "第一", start: 0, end: 0.6 }, { text: "句", start: 0.6, end: 0.9 }], durationSec: 0.9 }
          : { words: [{ text: "第二", start: 0, end: 0.7 }, { text: "句", start: 0.7, end: 1.1 }], durationSec: 1.1 };
      },
    };
    const ctx = {
      jobId: "j1", projectDir: dir, config: cfg,
      tts, feedback: null, log: () => {},
    } as unknown as StepContext;
    const r = await step3Tts(ctx, prev);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toEqual(expect.arrayContaining(["assets/narration.wav", "transcript.json"]));
    expect(existsSync(join(dir, "assets", "narration.wav"))).toBe(true);
    const boundaries = r.data.boundaries as { index: number; startSec: number; endSec: number }[];
    expect(boundaries).toHaveLength(2);
    expect(boundaries[1].startSec).toBeCloseTo(0.9, 1);
    expect(boundaries[1].endSec).toBeCloseTo(2.0, 1);
  });

  test("voiceover=false skips synthesis with estimated boundaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step3b-"));
    const prev: StepOutput[] = [
      { step: 0, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 1, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 2, status: "passed", artifacts: [], data: { storyboard: { beats: [{ durationSec: 2 }, { durationSec: 8 }] } }, log: "", attempts: 1 },
    ];
    const ctx = {
      jobId: "j1", projectDir: dir, config: { ...cfg, voiceover: false },
      tts: { synthesizeToWav: async () => { throw new Error("should not be called"); } },
      feedback: null, log: () => {},
    } as unknown as StepContext;
    const r = await step3Tts(ctx, prev);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toEqual([]);
    const boundaries = r.data.boundaries as { index: number; startSec: number; endSec: number }[];
    expect(boundaries).toEqual([
      { index: 1, startSec: 0, endSec: 2 },
      { index: 2, startSec: 2, endSec: 10 },
    ]);
  });
});
