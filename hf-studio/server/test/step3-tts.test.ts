import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step3Tts, estimateSec } from "../src/pipeline/steps/step3-tts";
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
  test("estimateSec converts narration length by speech rate", () => {
    expect(estimateSec("你好世界", "zh-CN")).toBeCloseTo(1.0, 5);       // 4 字 / 4 字每秒
    expect(estimateSec("Hello world", "en-US")).toBeCloseTo(10 / 13, 5); // 10 字母（空格不计）/ 13 每秒
    expect(estimateSec("", "zh-CN")).toBe(0.5);                          // 空文本下限
    expect(estimateSec("テスト", "ja-JP")).toBeCloseTo(3 / 5, 5);
    expect(estimateSec("abcdefgh", "fr-FR")).toBeCloseTo(1.0, 5);           // 未收录语言用默认语速 8
    expect(estimateSec("ab", "fr-FR")).toBe(0.5);                           // 低于 0.5s 时取下限兜底
    // 标点不计入字数：用与实现相同的口径计算期望（防手数错误）
    const punctText = "太阳，是地球最慷慨的能量来源。光伏效应，让光直接变成电。光子激发电子，形成电流。";
    const letters = punctText.replace(/[^\p{L}\p{N}]/gu, "").length;
    expect(estimateSec(punctText, "zh-CN")).toBeCloseTo(letters / 4, 5);
    expect(letters).toBe(34); // 锚定口径：34 字（不是原始 60 字符）
  });

  test("voiceover: synthesizes per beat, concatenates, writes transcript.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step3-"));
    const prev: StepOutput[] = [
      { step: 0, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 1, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
      {
        step: 2, status: "passed", artifacts: [], data: {
          storyboard: { beats: [
            // 旁白共 8 字（zh 语速 4 字/秒 → 估算 2.0s），与假 TTS 音频 2.0s 一致，过 30% 门
            { index: 1, id: "beat-1", title: "a", narration: "第一句话", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 0.9 },
            { index: 2, id: "beat-2", title: "b", narration: "第二句话", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 1.1 },
          ] },
        }, log: "", attempts: 1,
      },
    ];
    const tts = {
      synthesizeToWav: async (text: string, _voice: string, outWav: string) => {
        // 假合成：写一个最小合法 wav（16-bit 单声道 PCM 24kHz，20ms 静音，
        // ffmpeg concat -c copy 可解析拼接）+ 返回固定时间戳
        (await import("node:fs")).writeFileSync(outWav, fakeWav);
        return text === "第一句话"
          ? { words: [{ text: "第一", start: 0, end: 0.6 }, { text: "句话", start: 0.6, end: 0.9 }], durationSec: 0.9 }
          : { words: [{ text: "第二", start: 0, end: 0.7 }, { text: "句话", start: 0.7, end: 1.1 }], durationSec: 1.1 };
      },
    };
    const ctx = {
      jobId: "j1", projectDir: dir, config: cfg,
      tts, feedback: null, log: () => {},
      // 注入 ffprobe mock：beat-1 实测 0.9s，beat-2 实测 1.1s（真实时长，可能 ≠ TTS 返回的 durationSec）
      _probeMedia: async (wav: string) => wav.includes("beat-1")
        ? { durationSec: 0.9, hasAudio: true, hasVideo: false }
        : { durationSec: 1.1, hasAudio: true, hasVideo: false },
    } as unknown as StepContext;
    const r = await step3Tts(ctx, prev);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toEqual(expect.arrayContaining(["assets/narration.wav", "transcript.json"]));
    expect(existsSync(join(dir, "assets", "narration.wav"))).toBe(true);
    const boundaries = r.data.boundaries as { index: number; startSec: number; endSec: number }[];
    expect(boundaries).toHaveLength(2);
    // 视频边界必须与音频无缝拼接一致（无 gap）——若插入间隙，切换处露出宿主黑底导致黑屏 + 音画不同步
    expect(boundaries[0]).toMatchObject({ startSec: 0, endSec: 0.9 });
    expect(boundaries[1].startSec).toBeCloseTo(0.9, 1);
    expect(boundaries[1].endSec).toBeCloseTo(0.9 + 1.1, 1); // 2.0
    expect(r.data.realTotalSec).toBeCloseTo(2.0, 1);
  });

  test("voiceover: audio duration deviating >30% from estimate returns gate_failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step3c-"));
    const prev: StepOutput[] = [
      { step: 0, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
      { step: 1, status: "passed", artifacts: [], data: {}, log: "", attempts: 1 },
      {
        step: 2, status: "passed", artifacts: [], data: {
          storyboard: { beats: [
            // 旁白共 18 字（zh 语速 4 字/秒 → 估算 4.5s），假 TTS 音频 2.0s，偏差 55.6% > 30%
            { index: 1, id: "beat-1", title: "a", narration: "第一句话测试配音内容", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 5 },
            { index: 2, id: "beat-2", title: "b", narration: "第二句话测试配音内容", mood: "m", techniques: ["t"], transitions: "tr", assets: [], durationSec: 5 },
          ] },
        }, log: "", attempts: 1,
      },
    ];
    const tts = {
      synthesizeToWav: async (text: string, _voice: string, outWav: string) => {
        // 假合成：写一个最小合法 wav + 返回固定时间戳（合计 2.0s，与字数估算 4.5s 偏差 55.6%）
        (await import("node:fs")).writeFileSync(outWav, fakeWav);
        return text === "第一句话测试配音内容"
          ? { words: [{ text: "第一", start: 0, end: 0.6 }, { text: "句话", start: 0.6, end: 0.9 }], durationSec: 0.9 }
          : { words: [{ text: "第二", start: 0, end: 0.7 }, { text: "句话", start: 0.7, end: 1.1 }], durationSec: 1.1 };
      },
    };
    const ctx = {
      jobId: "j1", projectDir: dir, config: cfg,
      tts, feedback: null, log: () => {},
      // ffprobe mock：实测合计 2.0s（0.9+1.1，无间隙），与字数估算 4.5s 偏差 56% > 30% → 门用 realTotal 判失败
      _probeMedia: async (wav: string) => wav.includes("beat-1")
        ? { durationSec: 0.9, hasAudio: true, hasVideo: false }
        : { durationSec: 1.1, hasAudio: true, hasVideo: false },
    } as unknown as StepContext;
    const r = await step3Tts(ctx, prev);
    expect(r.status).toBe("gate_failed");
    expect(r.artifacts).toEqual([]);
    expect(r.gateErrors?.[0]).toContain("时长");
    expect(r.gateErrors?.[0]).toContain("偏差");
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
