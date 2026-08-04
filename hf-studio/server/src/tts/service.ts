// server/src/tts/service.ts —— Edge-TTS 合成 + 词级时间戳（Task 6）
//
// 与任务简报的 API 假设差异（均已对照 node_modules/msedge-tts/dist/*.d.ts 验证）：
// 1. 该包不导出 VOICE_LIST（grep 无此符号）——改用 `new MsEdgeTTS().getVoices()`
//    从微软接口拉取语音列表（返回字段为大写：ShortName/Gender/Locale）。
// 2. 该类不是 EventEmitter，没有 `on("wordBoundary")` 事件——词边界元数据通过
//    setMetadata 的第三个参数 `{ wordBoundaryEnabled: true }` 启用，
//    toFile() 落盘 metadata.json（{ Metadata: [{ Type, Data: { Offset, Duration, text: { Text } } }] }），
//    Offset/Duration 单位为 100ns tick，秒 = tick / 10_000_000。
// 3. toFile() 的第一个参数是"目录"而非文件路径，音频固定写为 <dir>/audio.<ext>，
//    返回 { audioFilePath, metadataFilePath }——因此先建临时目录，再用返回的
//    audioFilePath 交给 ffmpeg 转 wav。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export interface TtsWord { text: string; start: number; end: number }
export interface TtsVoice { shortName: string; gender: string; locale: string }

/** msedge-tts metadata.json 单条边界项的运行时形状（来自 dist/MsEdgeTTS.js _rawSSMLRequestToFile） */
interface EdgeMetadataItem {
  Type: string;                                      // "WordBoundary" | "SentenceBoundary"
  Data: { Offset: number; Duration: number; text: { Text: string; Length: number; BoundaryType: string } };
}

export class TtsService {
  constructor(private opts: { ffmpegBin?: string } = {}) {}

  async listVoices(langPrefix?: string): Promise<TtsVoice[]> {
    const tts = new MsEdgeTTS();
    const voices = await tts.getVoices();            // msedge-tts 无 VOICE_LIST 导出，需联网拉取
    const all: TtsVoice[] = voices.map((v) => ({ shortName: v.ShortName, gender: v.Gender, locale: v.Locale }));
    return langPrefix ? all.filter((v) => v.locale.startsWith(langPrefix)) : all;
  }

  async synthesizeToWav(text: string, voice: string, outWav: string): Promise<{ words: TtsWord[]; durationSec: number }> {
    const tts = new MsEdgeTTS();
    // 第三个参数启用词边界元数据（wordBoundaryEnabled 默认 false）
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
    const dir = join(tmpdir(), `hf-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const { audioFilePath, metadataFilePath } = await tts.toFile(dir, text);
      const ffmpeg = this.opts.ffmpegBin ?? "ffmpeg";
      execFileSync(ffmpeg, ["-y", "-i", audioFilePath, "-ar", "24000", "-ac", "1", outWav], { stdio: "pipe" });

      const words: TtsWord[] = [];
      if (metadataFilePath) {
        const meta = JSON.parse(readFileSync(metadataFilePath, "utf8")) as { Metadata: EdgeMetadataItem[] };
        for (const item of meta.Metadata) {
          if (item.Type !== "WordBoundary") continue;
          const start = item.Data.Offset / 10_000_000;
          const end = (item.Data.Offset + item.Data.Duration) / 10_000_000;
          words.push({ text: item.Data.text.Text, start, end });
        }
      }
      const durationSec = words.length > 0 ? words[words.length - 1].end : 0;
      if (durationSec <= 0) throw new Error(`TTS produced no word boundaries for voice ${voice}`);
      return { words, durationSec };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
