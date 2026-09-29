// server/src/pipeline/steps/jimeng-video.ts —— 即梦直出步骤的请求参数与状态读取（Phase 1 单条直出）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobConfig } from "../../types";

/** 默认模型：样片版（480p，省钱档）；可被 config.jimeng.model 覆盖 */
export const JIMENG_DEFAULT_MODEL = "seedance_2.5_draft";
export const JIMENG_DEFAULT_RESOLUTION = "480p";
export const JIMENG_DURATION_MIN = 4;
/** Phase 1 单条时长上限（控制花费；模型 2.5_draft 支持到 30s） */
export const JIMENG_DURATION_MAX = 15;

export function jimengModel(config: JobConfig): string {
  return config.jimeng?.model?.trim() || JIMENG_DEFAULT_MODEL;
}

export function jimengResolution(config: JobConfig): string {
  return config.jimeng?.resolution?.trim() || JIMENG_DEFAULT_RESOLUTION;
}

export function jimengRatio(format: JobConfig["format"]): string {
  switch (format) {
    case "portrait":
      return "9:16";
    case "square":
      return "1:1";
    default:
      return "16:9";
  }
}

export function jimengDurationSec(config: JobConfig): number {
  const wanted = Math.round(config.durationSec || JIMENG_DURATION_MIN);
  const max = Math.max(JIMENG_DURATION_MIN, Math.min(JIMENG_DURATION_MAX, config.jimeng?.clipMaxSec ?? JIMENG_DURATION_MAX));
  return Math.min(Math.max(wanted, JIMENG_DURATION_MIN), max);
}

export function jimengPrompt(config: JobConfig): string {
  const idea = (config.idea ?? "").trim();
  return idea || "一段简洁抽象的动态图形，缓慢运镜";
}

/** 单片段请求时长：向上取整并夹到 [4, clipMax]（即梦按整数秒计费/生成） */
export function clampDuration(sec: number, max: number = JIMENG_DURATION_MAX): number {
  const cap = Math.max(JIMENG_DURATION_MIN, Math.min(JIMENG_DURATION_MAX, max));
  const wanted = Math.ceil(sec);
  return Math.min(Math.max(wanted, JIMENG_DURATION_MIN), cap);
}

/** 从 DESIGN.md 提取一段风格提示（去 Markdown 标题、压缩空白、截断） */
export function extractStyleNote(designMd: string, max = 400): string {
  const text = (designMd ?? "")
    .split("\n")
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, max);
}

/** beat → 即梦提示词：旁白/主题 + 氛围 + 镜头手法 + 风格；要求无文字无水印（字幕由本中台后置烧录） */
/** 定妆图（锚点）默认模型：快速图片模型 */
export const JIMENG_DEFAULT_ANCHOR_MODEL = "seedream_5.0_pro";
export const JIMENG_ANCHOR_RESOLUTION = "2K";

export function jimengAnchorModel(config: JobConfig): string {
  return config.jimeng?.anchorModel?.trim() || JIMENG_DEFAULT_ANCHOR_MODEL;
}

export interface VisualBible {
  subject?: string;
  scene?: string;
  palette?: string;
  camera?: string;
}

const SHOT_DESC: Record<string, string> = {
  establishing: "中景主机位，主体位于画面中央，场景完整可见，镜头缓慢推进或轻微手持",
  closeup: "近景特写，聚焦主体面部表情，浅景深背景虚化",
  over_shoulder: "侧后方过肩视角，主体侧脸可见，前景带肩部轮廓",
  gesture: "中近景，强调手部与肢体动作，主体仍清晰可辨",
  insert: "道具/桌面特写，画面中不出现人脸",
};

/** 指定模型单次生成的最长秒数（静态兜底；实际以 CLI model list 为准，Phase 2.2 静态表足够） */
export function jimengModelMaxSec(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("pro_fast")) return 10;
  if (m.includes("2.5")) return 30;
  return 15; // seedance_2.0 系列 / mini / vip / fast / 其他
}

/** 制作计划：时长 ≤ 模型单次上限 → 直出（1 条）；超出 → 分镜拆分拼接 */
export function jimengPlan(config: JobConfig): "single" | "beats" {
  return config.durationSec <= jimengModelMaxSec(jimengModel(config)) ? "single" : "beats";
}

/** beat → 即梦提示词（Phase 2.1/2.2）：固定主体/场景 + 镜头语言 + 画面动作 + 原生台词；不逐句直译旁白 */
export function buildBeatPrompt(
  beat: { narration?: string; title: string; mood: string; visualAction?: string; shotType?: string; techniques?: string[]; transitions?: string },
  visual?: VisualBible | null,
  opts?: { contentType?: string },
): string {
  const parts: string[] = [];
  if (visual?.subject) parts.push(`主体：${visual.subject}`);
  if (visual?.scene) parts.push(`场景：${visual.scene}`);
  if (visual?.palette) parts.push(`色调：${visual.palette}`);
  const shot = SHOT_DESC[beat.shotType ?? "establishing"];
  if (shot) parts.push(`镜头：${shot}`);
  const action = beat.visualAction?.trim() || `画面主题：${beat.title}`;
  parts.push(`动作：${action}`);
  // 表演型内容：旁白作为"台词"由人物原生说出（模型自带配音与口型），不再后期贴 TTS
  if (opts?.contentType === "performance" && beat.narration?.trim()) {
    parts.push(`台词（人物直视镜头，用中文自然说出，口型与声音同步，语速自然）：「${beat.narration.trim()}」`);
  } else if (!beat.visualAction?.trim() && beat.narration?.trim()) {
    parts.push(`内容：${beat.narration.trim()}`);
  }
  parts.push("写实电影质感（photorealistic），真人实拍观感，不要卡通/插画/3D 渲染感");
  parts.push("画面保持主体与场景同一连贯，不出现任何文字、字幕或水印");
  return parts.join("；").slice(0, 1500);
}

/** 定妆图提示词：由视觉设定推导（主体/场景/色调各取一句，比例与原画幅一致） */
export function buildAnchorPrompt(visual: VisualBible): string {
  const parts = [
    visual.subject ? `主角设定：${visual.subject}` : "",
    visual.scene ? `场景：${visual.scene}` : "",
    visual.palette ? `色调参考：${visual.palette}` : "",
    visual.camera ? `构图：${visual.camera}` : "",
    // 写实红线：定妆图风格决定视频风格，必须真实摄影，禁止插画/3D/卡通渲染
    "写实电影剧照风格，真实摄影质感（photorealistic），35mm 胶片质感，自然皮肤纹理与毛孔、真实布料与材质细节、柔和真实光影、浅景深",
    "禁止：插画、绘画、3D 渲染、卡通、塑料感、夸张涂抹",
    "画面中不出现任何文字、字幕或水印；人物正面清晰、可直接作为视频生成参考",
  ].filter(Boolean);
  return parts.join("；").slice(0, 1200);
}

/** 读取 jimeng/state.json 的片段相对路径；缺省 jimeng/main.mp4 */
export function jimengClipRel(projectDir: string): string {
  try {
    const st = JSON.parse(readFileSync(join(projectDir, "jimeng", "state.json"), "utf8")) as { clipPath?: string };
    if (st.clipPath && typeof st.clipPath === "string") return st.clipPath;
  } catch {
    /* state 不存在时走缺省 */
  }
  return "jimeng/main.mp4";
}
