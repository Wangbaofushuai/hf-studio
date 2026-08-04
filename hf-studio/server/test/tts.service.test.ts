import { describe, expect, test } from "bun:test";
import { TtsService } from "../src/tts/service";

describe("TtsService", () => {
  test("listVoices returns voices filtered by language prefix", async () => {
    const svc = new TtsService();
    const voices = await svc.listVoices("zh-CN");
    expect(voices.length).toBeGreaterThan(0);
    for (const v of voices) expect(v.locale).toContain("zh-CN");
    expect(voices.some((v) => v.shortName.includes("Xiaoxiao"))).toBe(true);
  }, 60000);

  test("synthesizeToWav produces audio with word timestamps", async () => {
    const svc = new TtsService();
    const { words, durationSec } = await svc.synthesizeToWav(
      "你好，这是测试配音。",
      "zh-CN-XiaoxiaoNeural",
      `/tmp/hf-tts-test-${Date.now()}.wav`,
    );
    expect(words.length).toBeGreaterThan(0);
    expect(durationSec).toBeGreaterThan(0);
    for (const w of words) {
      expect(w.end).toBeGreaterThan(w.start);
      expect(w.start).toBeGreaterThanOrEqual(0);
    }
  }, 120000);
});
