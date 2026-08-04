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
  const expected = ctx.config.durationSec;
  const dev = Math.abs(probe.durationSec - expected) / expected;
  if (!probe.hasVideo || dev > 0.1) {
    return {
      status: "gate_failed", artifacts: [outPath], data: {},
      log: `渲染校验失败：时长 ${probe.durationSec.toFixed(1)}s vs 预期 ${expected}s`,
      gateErrors: [`渲染校验失败：hasVideo=${probe.hasVideo}, duration=${probe.durationSec.toFixed(1)}s, 偏差 ${(dev * 100).toFixed(0)}%`],
    };
  }
  return {
    status: "passed",
    artifacts: [outPath],
    data: { durationSec: probe.durationSec, hasVideo: probe.hasVideo },
    log: `渲染完成：${probe.durationSec.toFixed(1)}s`,
  };
};
