export interface SubtitleLine { startSec: number; endSec: number; text: string }
export interface SubtitleStyle {
  primaryColor: string;
  fontName: string;
  fontSizePx: number;
  marginVPx: number;
  width: number;
  height: number;
}

/** ASS 时间格式 H:MM:SS.cc（厘秒，截断；负数钳 0） */
export function formatAssTime(sec: number): string {
  const cs = Math.max(0, Math.floor(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const cc = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cc).padStart(2, "0")}`;
}

/** #RRGGBB → ASS &H00BBGGRR（alpha 固定 00 = 不透明）；非法输入兜底白色 */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "&H00FFFFFF";
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `&H00${b.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${r.toString(16).padStart(2, "0")}`.toUpperCase();
}

/** 将一段旁白按标点拆成多条字幕行，并在 [startSec, endSec] 内按字数比例分配时间（单条直出模式用） */
export function splitNarrationToLines(text: string, startSec: number, endSec: number): SubtitleLine[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [{ startSec, endSec, text: trimmed }];
  const weights = parts.map((p) => Array.from(p).length);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0.1, endSec - startSec);
  let cursor = startSec;
  return parts
    .map((p, i) => {
      const dur = i === parts.length - 1 ? endSec - cursor : Math.max(0.8, (weights[i] / totalW) * span);
      const line = { startSec: cursor, endSec: Math.min(endSec, cursor + dur), text: p };
      cursor = line.endSec;
      return line;
    })
    .filter((l) => l.endSec > l.startSec);
}

export function buildAss(lines: SubtitleLine[], style: SubtitleStyle, opts?: { topHook?: string; totalDurationSec?: number }): string {
  const hookSize = Math.max(20, Math.round(style.height * 0.062));
  const hookMarginV = Math.round(style.height * 0.032);
  const defaultStyle = `Style: Default,${style.fontName},${style.fontSizePx},${assColor(style.primaryColor)},&H00FFFFFF,&H00101010,&H66000000,0,0,0,0,100,100,0,0,3,0,0,2,60,60,${style.marginVPx},1`;
  // 顶部常驻钩子标题（包装）：加粗大字 + 深色底卡 + 主题色文字（Bold=1，Outline 作为底卡内边距）
  const hookStyle = opts?.topHook
    ? `\nStyle: TopHook,${style.fontName},${hookSize},${assColor(style.primaryColor)},&H00FFFFFF,&H00101010,&H99000000,1,0,0,0,100,100,0,0,3,10,0,8,60,60,${hookMarginV},1`
    : "";
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${style.width}
PlayResY: ${style.height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${defaultStyle}${hookStyle}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const esc = (t: string) => t.replace(/\r?\n/g, " ").replace(/{/g, "｛").replace(/}/g, "｝");
  const events = lines.map((l) => {
    return `Dialogue: 0,${formatAssTime(l.startSec)},${formatAssTime(l.endSec)},Default,,0,0,0,,${esc(l.text)}`;
  });
  const totalEnd = Math.max(lines.reduce((m, l) => Math.max(m, l.endSec), 0), opts?.totalDurationSec ?? 0);
  const hookEvent =
    opts?.topHook && totalEnd > 0
      ? [`Dialogue: 0,${formatAssTime(0)},${formatAssTime(totalEnd)},TopHook,,0,0,0,,${esc(opts.topHook)}`]
      : [];
  return header + [...hookEvent, ...events].join("\n") + "\n";
}

const HEX_RE = /#[0-9a-fA-F]{6}/g;

/** 相对亮度（WCAG，0=黑 1=白）——用于字幕取色的可读性兜底 */
export function hexLuminance(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 1;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** 字幕可读性下限：低于该亮度视为深色背景色（字幕自带半透明黑底，需要明显亮于黑底） */
const MIN_SUBTITLE_LUMINANCE = 0.2;

/** DESIGN.md 中首个亮度足够的 HEX（小写）——跳过后即深色背景色；无可用则 null */
export function extractPrimaryColor(designMd: string): string | null {
  if (!designMd) return null;
  const hexes: string[] = designMd.match(HEX_RE) ?? [];
  for (const h of hexes) {
    const v = h.toLowerCase();
    if (hexLuminance(v) >= MIN_SUBTITLE_LUMINANCE) return v;
  }
  return null;
}

/** 字幕取色优先级：主题 hue（用户显式指定，原样信任）→ DESIGN.md 首个亮色 HEX → 白色 */
export function pickPrimaryColor(themePrimary: string | undefined, designMd: string): string {
  if (themePrimary && /^#?[0-9a-fA-F]{6}$/.test(themePrimary.trim())) return themePrimary.trim();
  return extractPrimaryColor(designMd) ?? "#ffffff";
}
