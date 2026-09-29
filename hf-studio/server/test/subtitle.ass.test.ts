import { describe, expect, test } from "bun:test";
import { formatAssTime, assColor, buildAss, extractPrimaryColor, pickPrimaryColor } from "../src/subtitle/ass";

describe("ass subtitle builder", () => {
  test("formatAssTime formats H:MM:SS.cc", () => {
    expect(formatAssTime(0)).toBe("0:00:00.00");
    expect(formatAssTime(61.527)).toBe("0:01:01.52");
    expect(formatAssTime(600)).toBe("0:10:00.00");
    expect(formatAssTime(-1)).toBe("0:00:00.00");
  });

  test("assColor converts hex to ASS BGR", () => {
    expect(assColor("#0071e3")).toBe("&H00E37100");
    expect(assColor("#ffffff")).toBe("&H00FFFFFF");
    expect(assColor("not-a-color")).toBe("&H00FFFFFF");
  });

  test("buildAss emits valid sections and dialogues", () => {
    const ass = buildAss(
      [
        { startSec: 0, endSec: 1.5, text: "你好，世界" },
        { startSec: 1.5, endSec: 3, text: "第二段{a}测试" },
      ],
      { primaryColor: "#0071e3", fontName: "Noto Sans CJK SC", fontSizePx: 65, marginVPx: 54, width: 1920, height: 1080 },
    );
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("ScriptType: v4.00+");
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("Style: Default,Noto Sans CJK SC,65,&H00E37100,&H00FFFFFF,&H00101010,&H66000000,0,0,0,0,100,100,0,0,3,0,0,2,60,60,54,1");
    expect(ass).toContain("[Events]");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,你好，世界");
    expect(ass).toContain("Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,第二段｛a｝测试"); // {} 转全角防 override 解析
  });

  test("extractPrimaryColor finds first hex in DESIGN.md", () => {
    expect(extractPrimaryColor("## Quick Reference\n- 主色 #ff0000\n- 强调 #00ff00")).toBe("#ff0000");
    expect(extractPrimaryColor("no colors here")).toBeNull();
  });

  test("extractPrimaryColor 跳过后即深色背景色（字幕可读性）", () => {
    // 深色背景 → 面板色也深 → 取到亮蓝强调色
    expect(extractPrimaryColor("背景 #0A0E1A 面板 #121A2E 强调 #3B82F6")).toBe("#3b82f6");
    // 全深色 → null（由 pickPrimaryColor 兜底白色）
    expect(extractPrimaryColor("全深色 #0A0E1A #121A2E")).toBeNull();
    expect(pickPrimaryColor(undefined, "全深色 #0A0E1A")).toBe("#ffffff");
  });

  test("buildAss with topHook adds TopHook style and full-length dialogue", () => {
    const ass = buildAss(
      [
        { startSec: 0, endSec: 2, text: "第一句" },
        { startSec: 2, endSec: 5.5, text: "第二句" },
      ],
      { primaryColor: "#3b82f6", fontName: "Noto Sans CJK SC", fontSizePx: 65, marginVPx: 54, width: 1920, height: 1080 },
      { topHook: "越想回本，越容易加码" },
    );
    expect(ass).toContain("Style: TopHook,");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:05.50,TopHook,,0,0,0,,越想回本，越容易加码");
    expect(ass).toContain("Style: Default,");
    // 未传 topHook 时不产生 TopHook 样式
    const plain = buildAss([{ startSec: 0, endSec: 1, text: "x" }], { primaryColor: "#ffffff", fontName: "F", fontSizePx: 10, marginVPx: 5, width: 100, height: 100 });
    expect(plain).not.toContain("TopHook");
  });

  test("buildAss hook-only：无字幕行时仍输出 TopHook 事件（totalDurationSec）", () => {
    const ass = buildAss([], { primaryColor: "#3b82f6", fontName: "Noto Sans CJK SC", fontSizePx: 65, marginVPx: 54, width: 1920, height: 1080 }, { topHook: "脱口秀", totalDurationSec: 30 });
    expect(ass).toContain("Style: TopHook,");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:30.00,TopHook,,0,0,0,,脱口秀");
  });

  test("pickPrimaryColor prioritizes theme hue, then design, then fallback", () => {
    expect(pickPrimaryColor("#123456", "no colors")).toBe("#123456");
    expect(pickPrimaryColor("garbage", "主题色 #ff8800")).toBe("#ff8800");
    expect(pickPrimaryColor(undefined, "no colors")).toBe("#ffffff");
  });
});

