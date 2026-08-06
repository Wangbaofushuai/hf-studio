import { describe, expect, test } from "bun:test";
import { ensureCjkFontStack, stripClipAttrs, ensureRootAttrs, ensureRootWrapper } from "../src/util/clean-output";

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

  test("非本栈的声明（含 CJK 但缺 PingFang/YaHei）归一为完整栈", () => {
    const src = `#root { font-family: "Noto Sans CJK SC", sans-serif; }`;
    const out = ensureCjkFontStack(src);
    expect(out).toContain(CJK);
    expect(out).not.toContain('"Noto Sans CJK SC", sans-serif');
  });

  test("已经是本栈的声明保持原样", () => {
    const src = `#root { ${CJK} }`;
    expect(ensureCjkFontStack(src)).toBe(src);
  });

  test("任意具名字体（如 Noto Sans SC）归一为本栈", () => {
    const src = `#root { font-family: "Noto Sans SC", sans-serif; color: #333; }`;
    const out = ensureCjkFontStack(src);
    expect(out).toContain(CJK);
    expect(out).not.toContain("Noto Sans SC");
    expect(out).toContain("color: #333");
  });

  test("@font-face 块内的 font-family 不被归一", () => {
    const src = `@font-face { font-family: "CustomFont"; src: url(x.woff2); } .a{font-family:"CustomFont", sans-serif;}`;
    const out = ensureCjkFontStack(src);
    expect(out).toContain('font-family: "CustomFont";');
    // 使用 CustomFont 的声明仍被归一（避免 lint 对未覆盖字体的拦截）
    expect(out).toContain(CJK);
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

  test("脚本内容是字符串时不误伤（class=clip / data-start / font-family 字样）", () => {
    const src = `<template><div class="clip title" data-start="0.5" data-duration="1" data-track-index="3">标题</div>
<script>const s = 'class="clip" data-start="0.5" font-family: "Noto Sans SC", sans-serif;'; console.log(s);</script></template>`;
    const a = stripClipAttrs(src);
    // HTML 属性被剥：div 不再是 clip
    expect(a).not.toContain('<div class="clip');
    expect(a).not.toContain(`data-start="0.5" data-duration="1"`);
    // 脚本字符串原样保留（唯一保留处）
    expect(a).toContain(`const s = 'class="clip" data-start="0.5" font-family: "Noto Sans SC", sans-serif;'`);
    const b = ensureCjkFontStack(src);
    expect(b).toContain(`const s = 'class="clip" data-start="0.5" font-family: "Noto Sans SC", sans-serif;'`);
  });
});
describe("ensureRootAttrs", () => {
  test("根 div 缺属性时补齐 composition-id/width/height", () => {
    const src = `<template><div id="root"><div class="x">内容</div></div></template>`;
    const out = ensureRootAttrs(src, { id: "beat-1", w: 1080, h: 1920 });
    expect(out).toContain('id="root" data-composition-id="beat-1" data-width="1080" data-height="1920"');
  });
  test("已有属性时幂等不变", () => {
    const src = `<template><div id="root" data-composition-id="b" data-width="1" data-height="2"><div>x</div></div></template>`;
    expect(ensureRootAttrs(src, { id: "b", w: 1, h: 2 })).toBe(src);
  });
  test("无 id=root 时补到第一个 div；脚本内容不动", () => {
    const src = `<template><div class="frame"><script>const a = 'data-composition-id="x"';</script></div></template>`;
    const out = ensureRootAttrs(src, { id: "b3", w: 1920, h: 1080 });
    expect(out).toContain(`class="frame" data-composition-id="b3" data-width="1920" data-height="1080"`);
    expect(out).toContain(`const a = 'data-composition-id="x"';`);
  });
});

describe("ensureRootWrapper", () => {
  test("无根 div 时把 template 内容包进规范根 div", () => {
    const src = `<template><style>#root{}</style><div class="x">内容</div><script>const a = 1;</script></template>`;
    const out = ensureRootWrapper(src, { id: "beat-1", w: 1080, h: 1920 });
    expect(out).toContain(`<template>\n<div id="root" data-composition-id="beat-1" data-width="1080" data-height="1920">`);
    expect(out).toContain(`<style>#root{}</style>`);
    expect(out).toContain(`</div></template>`);
    expect(out).toContain(`const a = 1;`); // 脚本原样
  });
  test("已有 id=root → 只补属性不包裹", () => {
    const src = `<template><div id="root"><div>x</div></div></template>`;
    const out = ensureRootWrapper(src, { id: "b", w: 1, h: 2 });
    expect(out).toContain(`id="root" data-composition-id="b" data-width="1" data-height="2"`);
    expect((out.match(/id="root"/g) ?? []).length).toBe(1);
  });
});
