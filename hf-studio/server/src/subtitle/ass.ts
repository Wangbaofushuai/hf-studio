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

export function buildAss(lines: SubtitleLine[], style: SubtitleStyle): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${style.width}
PlayResY: ${style.height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontName},${style.fontSizePx},${assColor(style.primaryColor)},&H00FFFFFF,&H00101010,&H66000000,0,0,0,0,100,100,0,0,3,0,0,2,60,60,${style.marginVPx},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = lines.map((l) => {
    // {} 是 ASS override 标记，转全角防字幕文本被误解析
    const text = l.text.replace(/\r?\n/g, " ").replace(/{/g, "｛").replace(/}/g, "｝");
    return `Dialogue: 0,${formatAssTime(l.startSec)},${formatAssTime(l.endSec)},Default,,0,0,0,,${text}`;
  });
  return header + events.join("\n") + "\n";
}

const HEX_RE = /#[0-9a-fA-F]{6}/g;

/** DESIGN.md 中首个 HEX 颜色（小写）；无则 null */
export function extractPrimaryColor(designMd: string): string | null {
  if (!designMd) return null;
  const hexes: string[] = designMd.match(HEX_RE) ?? [];
  return hexes.length > 0 ? hexes[0].toLowerCase() : null;
}

export function pickPrimaryColor(themePrimary: string | undefined, designMd: string): string {
  if (themePrimary && /^#?[0-9a-fA-F]{6}$/.test(themePrimary.trim())) return themePrimary.trim();
  return extractPrimaryColor(designMd) ?? "#ffffff";
}
