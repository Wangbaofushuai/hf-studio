/** 剥离 LLM 输出可能包裹的 markdown 代码围栏（```html ... ```）——
 *  推理模型（如 deepseek-v4-flash）习惯性包裹输出，直接写盘会让 hyperframes 解析失败
 * （lint 报 root_missing_composition_id 等——E2E 实测 3 轮全败于此） */
export function stripCodeFences(content: string): string {
  return content.trim().replace(/^```(?:html|xml)?\s*/i, "").replace(/```\s*$/, "");
}

/** 中文字体栈 —— 服务端的 fontconfig 对 "system-ui" 等泛型栈解析不到中文字形
 * （fc-match "system-ui" :charset=4e00 为空 → headless 渲染成方块），
 * 必须按字体名显式声明（fc-match "Noto Sans CJK SC" 可命中）。 */
export const CJK_FONT_STACK =
  `"Noto Sans CJK SC", "Noto Sans CJK JP", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "WenQuanYi Micro Hei", sans-serif`;

/** 把 composition HTML 中所有含 system-ui 的 font-family 声明整体替换为中文字体栈。
 *  - 只动含 system-ui 的声明：那是 LLM 的默认写法且不带中文字形；显式西文字体（如 Georgia）
 *    与已含 Noto Sans CJK 的写法原样保留（含则跳过，防重复）。 */
export function ensureCjkFontStack(html: string): string {
  if (html.includes("Noto Sans CJK SC")) return html;
  return html.replace(/font-family\s*:\s*([^;}]*system-ui[^;}]*);?/gi, `font-family: ${CJK_FONT_STACK};`);
}
