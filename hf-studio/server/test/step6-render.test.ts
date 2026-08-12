import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step6Render } from "../src/pipeline/steps/step6-render";
import { probeMedia } from "../src/util/ffprobe";
import type { StepContext, JobConfig, StepOutput } from "../src/types";

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

  test("burns subtitles when enabled and beats present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step6-sub-"));
    const render = {
      render: async (out: string) => {
        const { execFileSync } = await import("node:child_process");
        execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2", "-pix_fmt", "yuv420p", out], { stdio: "pipe" });
      },
    };
    const prev = Array.from({ length: 5 }, () => ({ data: {} })) as unknown as StepOutput[];
    (prev as unknown as { data: Record<string, unknown> }[])[1].data = { design: "## Quick Reference\n主色 #ff0000" };
    (prev as unknown as { data: Record<string, unknown> }[])[2].data = {
      storyboard: { beats: [{ index: 1, narration: "你好世界" }, { index: 2, narration: "第二段" }] },
    };
    (prev as unknown as { data: Record<string, unknown> }[])[4].data = {
      beats: [{ index: 1, startSec: 0, endSec: 1 }, { index: 2, startSec: 1, endSec: 2 }],
    };
    const ctx = { jobId: "j1", projectDir: dir, config: { ...cfg, durationSec: 2, theme: { id: "tech", hue: { primary: "#123456" } } }, render, feedback: null, log: () => {} } as unknown as StepContext;
    const r = await step6Render(ctx, prev);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toContain("renders/output.mp4");
    expect(r.artifacts).toContain("renders/subs.ass");
    expect(existsSync(join(dir, "renders", "subs.ass"))).toBe(true);
    const ass = readFileSync(join(dir, "renders", "subs.ass"), "utf8");
    expect(ass).toContain("&H00563412"); // theme 主色 #123456 → ASS BGR
    expect(ass).toContain("你好世界");
  }, 120000);

  test("burn failure keeps original video and still passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-step6-noburn-"));
    const render = {
      render: async (out: string) => {
        const { execFileSync } = await import("node:child_process");
        execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2", "-pix_fmt", "yuv420p", out], { stdio: "pipe" });
      },
    };
    const prev = Array.from({ length: 5 }, () => ({ data: {} })) as unknown as StepOutput[];
    (prev as unknown as { data: Record<string, unknown> }[])[2].data = { storyboard: { beats: [{ index: 1, narration: "你好" }] } };
    (prev as unknown as { data: Record<string, unknown> }[])[4].data = { beats: [{ index: 1, startSec: 0, endSec: 2 }] };
    const ctx = {
      jobId: "j1", projectDir: dir, config: { ...cfg, durationSec: 2 },
      render, feedback: null, log: () => {},
      _burnSubtitles: async () => { throw new Error("burn boom"); }, // 注入失败烧录（沿 _probeMedia 注入模式）
    } as unknown as StepContext;
    const r = await step6Render(ctx, prev);
    expect(r.status).toBe("passed");
    expect(r.artifacts).toEqual(["renders/output.mp4"]); // 不包含 subs.ass
    expect(existsSync(join(dir, "renders", "output.mp4"))).toBe(true);
  }, 120000);
});
