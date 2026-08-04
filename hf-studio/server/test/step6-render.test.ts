import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step6Render } from "../src/pipeline/steps/step6-render";
import { probeMedia } from "../src/util/ffprobe";
import type { StepContext, JobConfig } from "../src/types";

const cfg: JobConfig = {
  idea: "t", durationSec: 9, format: "landscape", voiceover: true,
  voice: "zh-CN-XiaoxiaoNeural", language: "zh-CN",
  models: { default: "fake/model-a" }, materials: { images: [], audio: null },
};

describe("step6Render", () => {
  test("render success passes with expected duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step6-"));
    const render = {
      render: async (out: string) => {
        // 生成一个 2 秒黑场 mp4 作为真实产物（与测试用 cfg.durationSec=2 匹配）
        const { execFileSync } = await import("node:child_process");
        execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2", "-pix_fmt", "yuv420p", out], { stdio: "pipe" });
      },
    };
    const ctx = { jobId: "j1", projectDir: dir, config: { ...cfg, durationSec: 2 }, render, feedback: null, log: () => {} } as unknown as StepContext;
    const r = await step6Render(ctx, []);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toEqual(["renders/output.mp4"]);
  }, 60000);

  test("probeMedia reads duration and streams", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-probe-"));
    const { execFileSync } = await import("node:child_process");
    const mp4 = join(dir, "a.mp4");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2", "-pix_fmt", "yuv420p", mp4], { stdio: "pipe" });
    const p = await probeMedia(mp4);
    expect(p.hasVideo).toBe(true);
    expect(p.durationSec).toBeGreaterThan(1.5);
    expect(p.durationSec).toBeLessThan(3);
  }, 60000);
});
