/** 剥离 LLM 输出可能包裹的 markdown 代码围栏（```html ... ```）——
 *  推理模型（如 deepseek-v4-flash）习惯性包裹输出，直接写盘会让 hyperframes 解析失败
 * （lint 报 root_missing_composition_id 等——E2E 实测 3 轮全败于此） */
export function stripCodeFences(content: string): string {
  return content.trim().replace(/^```(?:html|xml)?\s*/i, "").replace(/```\s*$/, "");
}

/** 中文字体栈 —— 服务端的 fontconfig 对 "system-ui" 等泛型栈解析不到中文字形
 * （fc-match "system-ui" :charset=4e00 为空 → headless 渲染成方块），
 * 必须按字体名显式声明（fc-match "Noto Sans CJK SC" 可命中）。
 * 只列下方 CJK_FONT_FACE 覆盖到的 3 个字体：hyperframes 的 font_family_without_font_face
 * 会拦截不在其自动解析列表、又无 @font-face 的具名字体，多出的
 * "Noto Sans CJK JP"/"Hiragino Sans GB"/"WenQuanYi Micro Hei" 会让 lint 直接 FAIL。 */
export const CJK_FONT_STACK =
  `"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif`;

/** hyperframes 的 lint 规则 font_family_without_font_face 会拦截 font-family 里使用具名中文字体
 * （noto sans cjk sc / pingfang sc / microsoft yahei 不在其自动解析字体列表，直接 lint 即 FAIL）。
 * 修复（lint 自身指引 + 实测验证）：对系统内置字体补一条 `@font-face { font-family: 'X'; src: local('X'); }`
 * 声明即满足检查。本块在注入点（</template> 之前，style 保留在 template 内）一次性注入；
 * 已含 data-cjk-font 标记则跳过（幂等），避免重复注入。 */
const CJK_FONT_FACE = `\n<style data-cjk-font>
@font-face { font-family: "Noto Sans CJK SC"; src: local("Noto Sans CJK SC"); }
@font-face { font-family: "PingFang SC"; src: local("PingFang SC"); }
@font-face { font-family: "Microsoft YaHei"; src: local("Microsoft YaHei"); }
</style>`;

/** 把 composition HTML 中所有含 system-ui 的 font-family 声明整体替换为中文字体栈，并保证
 * HTML 内注入 @font-face 块（lint font_family_without_font_face 通过的必要条件）。
 *  - 只动含 system-ui 的声明：那是 LLM 的默认写法且不带中文字形；显式西文字体（如 Georgia）原样保留。
 *  - @font-face 注入幂等：已含 `data-cjk-font` 标记则跳过（不重复注入）。
 *  - 注入位置：`</template>` 之前（style 必须留在 template 内）；无 </template> 则退化到 </body> 前；
 *    两者皆无的输入是 CSS 片段而非完整合成文档，保持原样不注入。 */
/** 把 HTML 中的 <script> 块整体占位保护起来，返回 [保护后的文本, 还原函数]。
 *  清洗函数（正则替换）绝不该触碰脚本内容——脚本里的字符串若含
 *  'class="clip"' / 'data-start="…"' / 'font-family: …;' 会被误伤成语法错误。 */
function protectScripts(html: string): [string, (body: string) => string] {
  const parts: string[] = [];
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => {
    parts.push(m);
    return `\u0000HFSCRIPT${parts.length - 1}\u0000`;
  });
  return [body, (b) => b.replace(/\u0000HFSCRIPT(\d+)\u0000/g, (_m, i) => parts[+i])];
}

export function ensureCjkFontStack(html: string): string {
  // 保护 <script> 与 @font-face 块（前者是 JS 字符串，后者是字体名而非字体栈，均不得归一）
  const [preScript, restoreScript] = protectScripts(html);
  const faces: string[] = [];
  let body = preScript.replace(/@font-face\s*\{[^}]*\}/g, (m) => {
    faces.push(m);
    return `\u0000CJKFACE${faces.length - 1}\u0000`;
  });
  // 所有不在本栈的 font-family 声明整体归一为本栈——LLM 可能产出任意具名字体
  // （如 "Noto Sans SC"），不在 @font-face 覆盖集就会触发 font_family_without_font_face；
  // 统一归一后可保证 lint 通过 + 服务端可解析。
  const stackPattern = new RegExp(`font-family\\s*:\\s*${CJK_FONT_STACK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*;?`, "i");
  body = body.replace(/font-family\s*:\s*([^;}]+);?/gi, (m) => (stackPattern.test(m) ? m : `font-family: ${CJK_FONT_STACK};`));
  body = body.replace(/\u0000CJKFACE(\d+)\u0000/g, (_m, i) => faces[+i]);
  body = restoreScript(body);
  if (body.includes("data-cjk-font")) return body;
  if (body.includes("</template>")) return body.replace("</template>", CJK_FONT_FACE + "</template>");
  if (body.includes("</body>")) return body.replace("</body>", CJK_FONT_FACE + "</body>");
  return body;
}

/** 子合成（beat）内部禁止 clip 属性：class="clip" 与 data-start/data-duration/data-track-index
 * 只属于宿主槽位（index.html）。实测：子合成内使用 clip 属性触发平台窗口机制，窗口外元素被隐藏，
 * 导出视频大面积空白。本函数把这些属性从 beat HTML 中剥掉（宿主槽位由 root-html.ts 单独生成，不受影响）。 */
export function stripClipAttrs(html: string): string {
  // 脚本内容整体保护：JS 字符串里的 'class="clip"' / 'data-start="…"' 不得被误删
  const [preScript, restoreScript] = protectScripts(html);
  // 1) 从 class 值中移除 "clip"
  let out = preScript.replace(/class="([^"]*)\bclip\b([^"]*)"/g, (_m, pre, post) => {
    const merged = (pre + " " + post).replace(/\s+/g, " ").trim();
    return merged ? `class="${merged}"` : "";
  });
  // 2) 移除 data-start / data-duration / data-track-index
  out = out.replace(/\s*data-(?:start|duration|track-index)="[^"]*"/g, "");
  return restoreScript(out);
}

/** 保证子合成根元素携带 data-composition-id / data-width / data-height（lint 硬性要求）。
 *  LLM 偶尔漏写这些属性 → root_missing_composition_id / root_missing_dimensions 连续失败重试。
 *  流水线本身知道每 beat 的 id 与宽高，这里确定性补齐：目标 = 第一个 id="root" 的 div，
 *  找不到则取第一个 <div>；只补缺失的属性，幂等。脚本内容不动（保护）。 */
export function ensureRootAttrs(html: string, opts: { id: string; w: number; h: number }): string {
  const [preScript, restoreScript] = protectScripts(html);
  const attrs = (tag: string): string => {
    let out = tag;
    if (!/data-composition-id\s*=/.test(out)) out = out.replace(/\s*>$/, ` data-composition-id="${opts.id}">`);
    if (!/data-width\s*=/.test(out)) out = out.replace(/\s*>$/, ` data-width="${opts.w}">`);
    if (!/data-height\s*=/.test(out)) out = out.replace(/\s*>$/, ` data-height="${opts.h}">`);
    return out;
  };
  const rootTag = /<div\b[^>]*\bid="root"[^>]*>/i;
  const anyDiv = /<div\b[^>]*>/i;
  const body = rootTag.test(preScript)
    ? preScript.replace(rootTag, attrs)
    : preScript.replace(anyDiv, (m) => attrs(m));
  return restoreScript(body);
}
