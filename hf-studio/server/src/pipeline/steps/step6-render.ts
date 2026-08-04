import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StepContext, StepFn, StepResult } from "../../types";
import { probeMedia } from "../../util/ffprobe";

export const step6Render: StepFn = async (ctx: StepContext, prev): Promise<StepResult> => {
  const outPath = "renders/output.mp4";
  const abs = join(ctx.projectDir, outPath);
  // 确保输出目录存在（渲染器/ffmpeg 不会自动创建父目录，缺失时直接失败）
  mkdirSync(join(ctx.projectDir, "renders"), { recursive: true });
  try {
    await ctx.render.render(abs, "standard");
  } catch (e) {
    return { status: "gate_failed", artifacts: [], data: {}, log: `渲染失败`, gateErrors: [e instanceof Error ? e.message : String(e)] };
  }
  if (!existsSync(abs)) {
    return { status: "gate_failed", artifacts: [], data: {}, log: "渲染产物缺失", gateErrors: ["render 未产出文件"] };
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
    artifacts: [outPath],
    data: { durationSec: probe.durationSec, hasVideo: probe.hasVideo },
    log: `渲染完成：${probe.durationSec.toFixed(1)}s`,
  };
};
