import { describe, expect, test } from "bun:test";
import { ensureCjkFontStack } from "../src/util/clean-output";

const CJK = `font-family: "Noto Sans CJK SC", "Noto Sans CJK JP", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "WenQuanYi Micro Hei", sans-serif;`;

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
});