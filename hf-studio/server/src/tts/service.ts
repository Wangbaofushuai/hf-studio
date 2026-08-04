// server/src/tts/service.ts — Edge-TTS synthesis with word-level timestamps (Task 6)
//
// API differences from the task brief, verified against the installed
// node_modules/msedge-tts dist/*.d.ts (v2.0.7):
// 1. The package does not export VOICE_LIST (grep finds no such symbol) — voices are
//    fetched from Microsoft's endpoint via `new MsEdgeTTS().getVoices()` (capitalized
//    fields: ShortName/Gender/Locale).
// 2. MsEdgeTTS is not an EventEmitter and has no `on("wordBoundary")` event — word
//    boundaries are enabled via setMetadata's third argument
//    `{ wordBoundaryEnabled: true }` and written by toFile() to <dir>/metadata.json
//    as `{ Metadata: [{ Type, Data: { Offset, Duration, text: { Text } } }] }`.
//    Offset/Duration are 100ns ticks; seconds = ticks / 10_000_000.
// 3. toFile()'s first argument is a directory (not a file path); audio is always
//    written to <dir>/audio.<ext> and the returned paths are used for conversion.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export interface TtsWord { text: string; start: number; end: number }   // seconds
export interface TtsVoice { shortName: string; gender: string; locale: string }

// Runtime shape of one metadata.json boundary item (from dist/MsEdgeTTS.js _rawSSMLRequestToFile)
interface EdgeMetadataItem {
  Type: string;                                      // "WordBoundary" | "SentenceBoundary"
  Data: { Offset: number; Duration: number; text: { Text: string; Length: number; BoundaryType: string } };
}

export class TtsService {
  constructor(private opts: { ffmpegBin?: string } = {}) {}

  async listVoices(langPrefix?: string): Promise<TtsVoice[]> {
    const tts = new MsEdgeTTS();
    const voices = await tts.getVoices();            // no VOICE_LIST export; plain HTTP fetch, no WebSocket to close
    const all: TtsVoice[] = voices.map((v) => ({ shortName: v.ShortName, gender: v.Gender, locale: v.Locale }));
    return langPrefix ? all.filter((v) => v.locale.startsWith(langPrefix)) : all;
  }

  async synthesizeToWav(text: string, voice: string, outWav: string): Promise<{ words: TtsWord[]; durationSec: number }> {
    const tts = new MsEdgeTTS();
    const dir = join(tmpdir(), `hf-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
    try {
      // Third argument enables word-boundary metadata (wordBoundaryEnabled defaults to false)
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
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
      // Terminate the Edge WebSocket. toFile() resolves only after the audio stream is
      // fully written (turn.end), so closing here cannot truncate audio. close() uses
      // optional chaining on the underlying socket and is a no-op when unset or already
      // closed; the try/catch guards against any throw on double-close.
      try {
        tts.close();
      } catch {
        // ignore: socket may already be gone
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
