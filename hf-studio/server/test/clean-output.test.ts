import { describe, expect, test } from "bun:test";
import { ensureCjkFontStack, stripClipAttrs } from "../src/util/clean-output";

const CJK = `font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;`;

describe("ensureCjkFontStack", () => {
  test("system-ui 泛型栈整体替换为中文字体栈，其余样式保留", () => {
    const src = `#root { font-family: "system-ui", sans-serif; color: #111; font-size: 72px; }`;
    const out = ensureCjkFontStack(src);
    expect(out).toContain(CJK);
    expect(out).not.toContain("system-ui");
    expect(out).toContain("color: #111");
    expect(out).toContain("font-size: 72px");
  });

  test("已含 Noto Sans CJK SC 的输出不再改写", () => {
    const src = `#root { font-family: "Noto Sans CJK SC", sans-serif; }`;
    expect(ensureCjkFontStack(src)).toBe(src);
  });

  test("显式西文字体（Georgia）保持不变", () => {
    const src = `.title-line { font-family: Georgia, serif; }`;
    expect(ensureCjkFontStack(src)).toBe(src);
  });

  test("多处出现 system-ui（大小写不敏感）全部替换", () => {
    const src = `#root{font-family:"system-ui",sans-serif}.a{font-family:SYSTEM-UI}`;
    const out = ensureCjkFontStack(src);
    expect(out).not.toContain("system-ui");
    expect(out).not.toContain("SYSTEM-UI");
  });

  test("system-ui 替换 + @font-face 注入同时发生（注入在 </template> 之前）", () => {
    const src = `#root{font-family:"system-ui",sans-serif}</template>`;
    const out = ensureCjkFontStack(src);
    expect(out).toContain(CJK);
    expect(out).not.toContain("system-ui");
    expect(out).toContain("data-cjk-font");
    expect(out).toContain(`src: local("Noto Sans CJK SC")`);
    // 注入块紧贴 </template> 之前（style 保留在 template 内）
    expect(out.endsWith(`</style></template>`)).toBe(true);
  });

  test("已含 data-cjk-font 标记 → 不重复注入，但 system-ui 仍被替换", () => {
    const src = `<style data-cjk-font>
@font-face { font-family: "Noto Sans CJK SC"; src: local("Noto Sans CJK SC"); }
@font-face { font-family: "PingFang SC"; src: local("PingFang SC"); }
@font-face { font-family: "Microsoft YaHei"; src: local("Microsoft YaHei"); }
</style>
#root{font-family:"system-ui",sans-serif}`;
    const out = ensureCjkFontStack(src);
    // @font-face 块只出现一次（无重复注入）
    expect(out.match(/@font-face/g)!.length).toBe(3);
    expect(out.indexOf("data-cjk-font")).toBe(out.lastIndexOf("data-cjk-font"));
    expect(out).toContain(CJK);
    expect(out).not.toContain("system-ui");
  });

  test("无 </template> → 退化到 </body> 前注入", () => {
    const src = `#root{font-family:"system-ui",sans-serif}</body></html>`;
    const out = ensureCjkFontStack(src);
    expect(out).not.toContain("system-ui");
    expect(out).toContain("data-cjk-font");
    expect(out).toContain(`src: local("Noto Sans CJK SC")`);
    expect(out.endsWith(`</style></body></html>`)).toBe(true);
  });
});

describe("stripClipAttrs", () => {
  test("剥掉 class='clip' 与 data-* 时间属性", () => {
    const src = `<div id="root" data-composition-id="beat-1" data-width="1080" data-height="1920" data-duration="2.925"><div class="clip title-wrap" data-start="0.8" data-duration="1.8" data-track-index="5">标题</div></div>`;
    const out = stripClipAttrs(src);
    expect(out).not.toContain("clip");
    expect(out).not.toContain("data-start");
    expect(out).not.toContain("data-track-index");
    expect(out).toContain('data-composition-id="beat-1"');
    expect(out).toContain('data-width="1080"');
  });
  test("class 多值里 clip 移除后保留其余类", () => {
    expect(stripClipAttrs(`<div class="clip title-wrap">`)).toBe(`<div class="title-wrap">`);
    expect(stripClipAttrs(`<div class="title-wrap clip">`)).toBe(`<div class="title-wrap">`);
  });
  test("无 clip 的输入仅剥离时间属性", () => {
    const out = stripClipAttrs(`<div class="a" data-x="1">`);
    expect(out).toBe(`<div class="a" data-x="1">`);
  });
});