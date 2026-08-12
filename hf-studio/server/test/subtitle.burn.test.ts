import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { burnSubtitles } from "../src/subtitle/burn";
import { buildAss } from "../src/subtitle/ass";
import { probeMedia } from "../src/util/ffprobe";

describe("burnSubtitles", () => {
  test("burns ass onto a tiny video keeping duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-burn-"));
    const input = join(dir, "in.mp4");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2", "-pix_fmt", "yuv420p", input], { stdio: "pipe" });
    const assPath = join(dir, "subs.ass");
    writeFileSync(assPath, buildAss([{ startSec: 0, endSec: 2, text: "测试字幕" }], { primaryColor: "#ffffff", fontName: "Noto Sans CJK SC", fontSizePx: 20, marginVPx: 12, width: 320, height: 240 }));
    const out = join(dir, "out.mp4");
    await burnSubtitles(input, assPath, out);
    expect(existsSync(out)).toBe(true);
    const probe = await probeMedia(out);
    expect(probe.hasVideo).toBe(true);
    expect(probe.durationSec).toBeGreaterThan(1.5);
    expect(probe.durationSec).toBeLessThan(3);
    rmSync(dir, { recursive: true, force: true });
  }, 120000);

  test("throws on missing ass and leaves no temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-burn2-"));
    const input = join(dir, "in.mp4");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1", "-pix_fmt", "yuv420p", input], { stdio: "pipe" });
    await expect(burnSubtitles(input, join(dir, "nope.ass"), join(dir, "out.mp4"))).rejects.toThrow();
    expect(existsSync(join(dir, "out.mp4.subtmp.mp4"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 120000);
});
