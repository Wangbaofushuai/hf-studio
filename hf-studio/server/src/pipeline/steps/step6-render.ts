import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepOutput, StepResult } from "../../types";
import { probeMedia } from "../../util/ffprobe";
import { assembleBeats, type AssembleBeat } from "../../util/assemble";
import { RESOLUTIONS } from "../../render/resolutions";
import { buildAss, pickPrimaryColor, splitNarrationToLines, type SubtitleLine, type SubtitleStyle } from "../../subtitle/ass";
import { burnSubtitles } from "../../subtitle/burn";
import { jimengClipRel } from "./jimeng-video";

/** 旁白硬字幕 + 顶部钩子标题烧录（两模式共用）；失败不判任务失败，返回字幕 artifact 或 null */
async function burnNarrationSubtitles(ctx: StepContext, prev: StepOutput[], videoAbs: string): Promise<string | null> {
  // jimeng 表演型内容：台词由即梦原生配音（无 Edge-TTS），字幕仍需展示
  const nativeSpeech = ctx.config.mode === "jimeng" && (prev[2]?.data.contentType as string | undefined) === "performance";
  const doSubtitles = ctx.config.subtitles !== false && (ctx.config.voiceover || nativeSpeech);
  if (!doSubtitles) return null;
  const storyBeats = (prev[2]?.data.storyboard as { beats: { index: number; narration: string }[] } | undefined)?.beats ?? [];
  const timedBeats = (prev[4]?.data.beats as { index?: number; startSec: number; endSec: number }[] | undefined) ?? [];
  const { w, h } = RESOLUTIONS[ctx.config.format];
  const designMd = (prev[1]?.data.design as string | undefined)
    ?? (existsSync(join(ctx.projectDir, "DESIGN.md")) ? readFileSync(join(ctx.projectDir, "DESIGN.md"), "utf8") : "");
  const lines: SubtitleLine[] = doSubtitles
    ? (timedBeats.length === 1
        ? splitNarrationToLines(storyBeats[0]?.narration ?? "", timedBeats[0].startSec, timedBeats[0].endSec)
        : timedBeats
            .map((tb, i) => ({ startSec: tb.startSec, endSec: tb.endSec, text: storyBeats[i]?.narration ?? "" }))
            .filter((l) => l.text.trim().length > 0))
    : [];
  if (lines.length === 0) return null;
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
    await burn(videoAbs, assPath, videoAbs);
    ctx.log(`字幕烧录完成（${lines.length} 条）`);
    return "renders/subs.ass";
  } catch (e) {
    ctx.log(`字幕烧录失败（保留无字幕视频）: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export const step6Render: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const outPath = "renders/output.mp4";
  const abs = join(ctx.projectDir, outPath);
  // 清晰度档位：引擎注入 `_renderQuality`（默认 standard）；直接调用时回退到 config.renderQuality
  const quality = (ctx as unknown as { _renderQuality?: string })._renderQuality ?? ctx.config.renderQuality ?? "standard";
  // 确保输出目录存在（渲染器/ffmpeg 不会自动创建父目录，缺失时直接失败）
  mkdirSync(join(ctx.projectDir, "renders"), { recursive: true });

  // —— AI 直出（jimeng）分支 ——
  if (ctx.config.mode === "jimeng") {
    const jm = prev[4]?.data.jimeng as { items?: Record<string, { clipPath?: string }>; clipPath?: string } | undefined;
    const timed = (prev[4]?.data.beats as { id?: string; index: number; startSec: number; endSec: number }[] | undefined) ?? [];
    const isBeats = Boolean(jm?.items && Object.keys(jm.items).length > 0 && timed.length > 0);

    if (isBeats) {
      // Phase 2：逐 beat 归一化拼接（+ 可选旁白混音 + 字幕）
      const items = jm!.items!;
      const clips: AssembleBeat[] = [];
      const missing: string[] = [];
      for (const t of timed) {
        const rel = t.id ? items[t.id]?.clipPath : undefined;
        if (!rel) { missing.push(`${t.id ?? `beat-${t.index}`} 缺少片段`); continue; }
        const clipAbsPath = join(ctx.projectDir, rel);
        if (!existsSync(clipAbsPath)) { missing.push(`${rel} 不存在`); continue; }
        clips.push({ clipAbsPath, durationSec: Math.max(1, t.endSec - t.startSec) });
      }
      if (missing.length > 0 || clips.length !== timed.length) {
        return { status: "gate_failed", artifacts: [], data: {}, log: `即梦片段缺失（${missing.length} 项）`, gateErrors: missing };
      }
      const workDir = join(ctx.projectDir, "jimeng", "assembly");
      mkdirSync(workDir, { recursive: true });
      const contentType = prev[2]?.data.contentType as string | undefined;
      // 表演型内容：台词为即梦原生配音（混合成片会双声道打架）→ 不混 Edge-TTS；explainer 维持
      const useEdgeTts = ctx.config.voiceover && contentType !== "performance";
      const narration = useEdgeTts && existsSync(join(ctx.projectDir, "narration.wav"))
        ? join(ctx.projectDir, "narration.wav")
        : null;
      try {
        await assembleBeats({ workDir, beats: clips, outPath: abs, narrationWav: narration });
      } catch (e) {
        return { status: "gate_failed", artifacts: [], data: {}, log: "即梦拼接失败", gateErrors: [e instanceof Error ? e.message : String(e)] };
      }
      const subsArtifact = await burnNarrationSubtitles(ctx, prev, abs);
      const expected = timed.length > 0 ? timed[timed.length - 1].endSec - timed[0].startSec : ctx.config.durationSec;
      const probe = await probeMedia(abs);
      const dev = expected > 0 ? Math.abs(probe.durationSec - expected) / expected : 0;
      if (!probe.hasVideo || dev > 0.1) {
        return {
          status: "gate_failed",
          artifacts: [outPath],
          data: {},
          log: `即梦成片校验失败：${probe.durationSec.toFixed(1)}s vs 预期 ${expected.toFixed(1)}s`,
          gateErrors: [`hasVideo=${probe.hasVideo}, hasAudio=${probe.hasAudio}, duration=${probe.durationSec.toFixed(1)}s, 预期=${expected.toFixed(1)}s, 偏差 ${(dev * 100).toFixed(0)}%`],
        };
      }
      return {
        status: "passed",
        artifacts: subsArtifact ? [outPath, subsArtifact] : [outPath],
        data: { durationSec: probe.durationSec, hasVideo: probe.hasVideo, hasAudio: probe.hasAudio, mode: "jimeng", beats: clips.length, subtitles: subsArtifact !== null },
        log: `即梦直出成片：${outPath}（${probe.durationSec.toFixed(1)}s，${clips.length} 段${subsArtifact ? "，含字幕" : ""}）`,
      };
    }

    // Phase 1 兼容：单条片段复制为成片
    const rel = jimengClipRel(ctx.projectDir);
    const clipAbs = join(ctx.projectDir, rel);
    if (!existsSync(clipAbs)) {
      return { status: "gate_failed", artifacts: [], data: {}, log: `即梦片段缺失：${rel}`, gateErrors: [`${rel} 不存在`] };
    }
    try {
      copyFileSync(clipAbs, abs);
    } catch (e) {
      return {
        status: "gate_failed",
        artifacts: [],
        data: {},
        log: "即梦成片复制失败",
        gateErrors: [e instanceof Error ? e.message : String(e)],
      };
    }
    const probe = await probeMedia(abs);
    if (!probe.hasVideo || probe.durationSec <= 0) {
      return {
        status: "gate_failed",
        artifacts: [outPath],
        data: {},
        log: `即梦成片校验失败：hasVideo=${probe.hasVideo}, duration=${probe.durationSec.toFixed(1)}s`,
        gateErrors: ["成片无有效视频流"],
      };
    }
    return {
      status: "passed",
      artifacts: [outPath],
      data: { durationSec: probe.durationSec, hasVideo: probe.hasVideo, mode: "jimeng" },
      log: `即梦直出成片：${outPath}（${probe.durationSec.toFixed(1)}s）`,
    };
  }

  try {
    await ctx.render.render(abs, quality as "standard" | "high");
  } catch (e) {
    return { status: "gate_failed", artifacts: [], data: {}, log: `渲染失败`, gateErrors: [e instanceof Error ? e.message : String(e)] };
  }
  if (!existsSync(abs)) {
    return { status: "gate_failed", artifacts: [], data: {}, log: "渲染产物缺失", gateErrors: ["render 未产出文件"] };
  }

  const subsArtifact = await burnNarrationSubtitles(ctx, prev, abs);

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
