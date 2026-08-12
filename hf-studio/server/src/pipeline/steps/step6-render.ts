import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult } from "../../types";
import { probeMedia } from "../../util/ffprobe";
import { RESOLUTIONS } from "../../render/resolutions";
import { buildAss, pickPrimaryColor, type SubtitleLine, type SubtitleStyle } from "../../subtitle/ass";
import { burnSubtitles } from "../../subtitle/burn";

export const step6Render: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const outPath = "renders/output.mp4";
  const abs = join(ctx.projectDir, outPath);
  // 清晰度档位：引擎注入 `_renderQuality`（默认 standard）；直接调用时回退到 config.renderQuality
  const quality = (ctx as unknown as { _renderQuality?: string })._renderQuality ?? ctx.config.renderQuality ?? "standard";
  // 确保输出目录存在（渲染器/ffmpeg 不会自动创建父目录，缺失时直接失败）
  mkdirSync(join(ctx.projectDir, "renders"), { recursive: true });
  try {
    await ctx.render.render(abs, quality as "standard" | "high");
  } catch (e) {
    return { status: "gate_failed", artifacts: [], data: {}, log: `渲染失败`, gateErrors: [e instanceof Error ? e.message : String(e)] };
  }
  if (!existsSync(abs)) {
    return { status: "gate_failed", artifacts: [], data: {}, log: "渲染产物缺失", gateErrors: ["render 未产出文件"] };
  }

  // 字幕烧录：默认开启；配音关闭或缺少 beat 数据时跳过。烧录失败不判任务失败（保留无字幕原片）。
  const doSubtitles = ctx.config.subtitles !== false && ctx.config.voiceover;
  let subsArtifact: string | null = null;
  if (doSubtitles) {
    const storyBeats = (prev[2]?.data.storyboard as { beats: { index: number; narration: string }[] } | undefined)?.beats ?? [];
    const timedBeats = (prev[4]?.data.beats as { index?: number; startSec: number; endSec: number }[] | undefined) ?? [];
    if (storyBeats.length > 0 && timedBeats.length > 0) {
      const { w, h } = RESOLUTIONS[ctx.config.format];
      const designMd = (prev[1]?.data.design as string | undefined)
        ?? (existsSync(join(ctx.projectDir, "DESIGN.md")) ? readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8") : "");
      const lines: SubtitleLine[] = timedBeats
        .map((tb, i) => ({ startSec: tb.startSec, endSec: tb.endSec, text: storyBeats[i]?.narration ?? "" }))
        .filter((l) => l.text.trim().length > 0);
      if (lines.length > 0) {
        const style: SubtitleStyle = {
          primaryColor: pickPrimaryColor(ctx.config.theme?.hue?.primary, designMd),
          fontName: "Noto Sans CJK SC",
          fontSizePx: Math.max(16, Math.round(h * 0.06)),
          marginVPx: Math.round(h * 0.05),
          width: w,
          height: h,
        };
        const assPath = join(ctx.projectDir, "renders", "subs.ass");
        writeFileSync(assPath, buildAss(lines, style));
        const burn = (ctx as unknown as { _burnSubtitles?: typeof burnSubtitles })._burnSubtitles ?? burnSubtitles;
        try {
          await burn(abs, assPath, abs);
          subsArtifact = "renders/subs.ass";
          ctx.log(`字幕烧录完成（${lines.length} 条）`);
        } catch (e) {
          ctx.log(`字幕烧录失败（保留无字幕视频）: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  const probe = await probeMedia(abs);
  // 对照时间线总长（最后一个 beat 的 endSec = 根合成 data-duration），而非 config 目标：
  // 渲染门只负责抓"渲染截断/拉长"类真故障；"视频是否够长"由 step2 的旁白长度门保证，
  // 语速自然波动（±10% 常见）不应误杀渲染本身
  const timelineSec = (prev[4]?.data.beats as { endSec: number }[] | undefined)?.at(-1)?.endSec ?? ctx.config.durationSec;
  const expected = timelineSec;
  const dev = Math.abs(probe.durationSec - expected) / expected;
  if (!probe.hasVideo || dev > 0.1) {
    return {
      status: "gate_failed", artifacts: [outPath], data: {},
      log: `渲染校验失败：时长 ${probe.durationSec.toFixed(1)}s vs 时间线 ${expected.toFixed(1)}s`,
      gateErrors: [`渲染校验失败：hasVideo=${probe.hasVideo}, duration=${probe.durationSec.toFixed(1)}s, 时间线=${expected.toFixed(1)}s, 偏差 ${(dev * 100).toFixed(0)}%`],
    };
  }
  return {
    status: "passed",
    artifacts: subsArtifact ? [outPath, subsArtifact] : [outPath],
    data: { durationSec: probe.durationSec, hasVideo: probe.hasVideo, subtitles: subsArtifact !== null },
    log: `渲染完成：${probe.durationSec.toFixed(1)}s${subsArtifact ? "（含字幕）" : ""}`,
  };
};
