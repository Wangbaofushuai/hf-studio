# 新建任务向导 + 中文渲染字体修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复生成视频中文渲染成方块的问题，并把「新建任务」改造成 3 步向导、导航「模型渠道」改名「设置」。

**Architecture:** 服务端在写 composition 时对输出做一次字体栈清洗（`ensureCjkFontStack`），配合 build-beat 提示词约束，双防线保证中文字形可渲染；前端把 NewJob 单页拆成 3 步面板 + 顶部步骤条，状态留在组件内。

**Tech Stack:** bun + TypeScript（服务端，bun:test）；React 19 + Vite + Tailwind v4（前端）；hyperframes CLI（渲染验证）。

## Global Constraints

- 执行子代理模型固定为 **deepseek-v4-flash**（用户指定）
- 不改宿主机：不装字体、不动 fontconfig、不装任何全局软件
- 服务端验证：`cd hf-studio/server && bun test --timeout 60000 && tsc --noEmit`（全绿）
- 前端验证：`cd hf-studio/web && bun run build`（通过）
- 不新增依赖；文件命名语义化；提交信息小步原子、描述清晰（`feat:` / `fix:` / `docs:`）
- spec：`docs/superpowers/specs/2026-08-05-newjob-wizard-cjk-font-design.md`

---

### Task 1: 中文字体栈清洗（服务端，TDD）

**Files:**
- Modify: `hf-studio/server/src/util/clean-output.ts`（新增 `ensureCjkFontStack` 导出）
- Create: `hf-studio/server/test/clean-output.test.ts`
- Modify: `hf-studio/server/src/pipeline/steps/step4-build.ts:91`（`writeFileSync(file, stripCodeFences(content))` → 包一层）
- Modify: `hf-studio/server/src/pipeline/steps/step5-validate.ts:56`（`writeFileSync(abs, stripCodeFences(fixed))` → 包一层）
- Modify: `hf-studio/server/src/prompts/build-beat.txt`（字体约束）

**Interfaces:**
- Consumes: `stripCodeFences`（已存在于 `clean-output.ts`）
- Produces: `export function ensureCjkFontStack(html: string): string` —— 返回把「含 system-ui 的 font-family 声明」整体替换为中文字体栈、其余内容原样的 HTML；若 HTML 已含 `Noto Sans CJK SC` 则原样返回。

- [ ] **Step 1: 写失败测试**

创建 `hf-studio/server/test/clean-output.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd hf-studio/server && bun test test/clean-output.test.ts`
Expected: 编译失败 / 断言失败（`ensureCjkFontStack` 未定义）

- [ ] **Step 3: 实现 util**

在 `hf-studio/server/src/util/clean-output.ts` 追加：

```ts
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
  return html.replace(/font-family\s*:\s*([^;}]*system-ui[^;}]*);/gi, `font-family: ${CJK_FONT_STACK};`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd hf-studio/server && bun test test/clean-output.test.ts`
Expected: 4 项全 PASS

- [ ] **Step 5: 接入 step4 写盘**

`hf-studio/server/src/pipeline/steps/step4-build.ts:3` 的 import 追加 `ensureCjkFontStack`；第 91 行改为：

```ts
writeFileSync(file, ensureCjkFontStack(stripCodeFences(content)));
```

- [ ] **Step 6: 接入 step5 修复写盘**

`hf-studio/server/src/pipeline/steps/step5-validate.ts:4` 已 import `stripCodeFences`，同句追加 `ensureCjkFontStack`；第 56 行改为：

```ts
writeFileSync(abs, ensureCjkFontStack(stripCodeFences(fixed)));
```

- [ ] **Step 7: 更新 build-beat 提示词**

在 `hf-studio/server/src/prompts/build-beat.txt` 的 HyperFrames 契约/视觉规范部分追加一条（放在第 2 条根元素之后）：

```
3. 字体：所有文字必须使用中文字体栈 font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif；
   禁止使用 system-ui 或仅 sans-serif 这类不保证中文字形的字体栈（服务端无法解析 → 渲染成方块）。
   西文装饰字体可叠加在中文栈之前，如 font-family: "Georgia", "Noto Sans CJK SC", sans-serif。
```

（若契约编号与原文冲突，改为追加在同级样式列表末尾，标注「字体」。）

- [ ] **Step 8: 全量服务端验证**

Run: `cd hf-studio/server && bun test --timeout 60000 && tsc --noEmit`
Expected: 全部 PASS + 类型检查通过

- [ ] **Step 9: 提交**

```bash
git add hf-studio/server/src/util/clean-output.ts hf-studio/server/test/clean-output.test.ts hf-studio/server/src/pipeline/steps/step4-build.ts hf-studio/server/src/pipeline/steps/step5-validate.ts hf-studio/server/src/prompts/build-beat.txt
git commit -m "fix: enforce CJK font stack on compositions (system-ui resolves no Chinese glyphs)"
```

---

### Task 2: 新建任务 3 步向导 + 导航改名「设置」（前端）

**Files:**
- Modify: `hf-studio/web/src/pages/NewJob.tsx`（拆 3 步面板）
- Create: `hf-studio/web/src/components/WizardSteps.tsx`
- Modify: `hf-studio/web/src/App.tsx:10`（`label: "模型渠道"` → `label: "设置"`）
- Modify: `hf-studio/web/src/pages/Channels.tsx`（页面标题 + 板块标题）

**Interfaces:**
- Consumes: 现有 `api.ts` 的 `createJob` / `fetchChannels`、`VoiceSelect`、`FORMATS`；现有全部表单 state
- Produces: `WizardSteps` 组件（`steps: string[]`、`current: number`、`maxReached: number`、`onJump(i: number): void`）

- [ ] **Step 1: 新建 WizardSteps 组件**

`hf-studio/web/src/components/WizardSteps.tsx`：

```tsx
export default function WizardSteps({ steps, current, maxReached, onJump }: {
  steps: string[];
  current: number;
  maxReached: number;
  onJump: (i: number) => void;
}) {
  return (
    <ol className="flex items-center gap-1.5">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <button type="button" disabled={i > maxReached} onClick={() => onJump(i)}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors ${
                active ? "bg-[#0071e3] text-white" : done ? "text-[#0071e3] hover:bg-black/[0.04]" : i > maxReached ? "cursor-not-allowed text-neutral-300" : "text-neutral-500 hover:bg-black/[0.04]"
              }`}>
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                active ? "bg-white/20" : done ? "bg-[#0071e3]/10" : "bg-black/[0.06]"
              }`}>{done ? "✓" : i + 1}</span>
              <span>{label}</span>
            </button>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />}
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 2: NewJob 拆成 3 步**

`hf-studio/web/src/pages/NewJob.tsx`：
- 新增 state：`const [step, setStep] = useState(0); const [maxReached, setMaxReached] = useState(0);` 与 `const STEPS = ["内容设置", "模型", "素材与确认"];`
- 把现有三段 `<section>` 各包进 `{step === 0 && ...}` / `{step === 1 && ...}` / `{step === 2 && ...}`，内容与控件原样保留；第 1 步 = 想法 + 视频设置段，第 2 步 = 模型渠道段（含「管理渠道 →」链接与临时自定义折叠），第 3 步 = 素材段
- 第 3 步在素材段上方加「配置汇总」卡（`glass` 样式），列出：想法（截断 60 字）、时长/画幅/配音/语言/音色、渠道名与模型（`finalModel` 同现有提交逻辑）
- 校验：`const canNext = step === 0 ? idea.trim().length > 0 : step === 1 ? Boolean(finalModel) : true;`（`finalModel` 复用现有计算逻辑，含临时自定义渠道分支）
- `onJump(i)`：`if (i <= maxReached) setStep(i);`
- 页脚按钮（表单内 `type="button"`）：
  - `step > 0`：`上一步`（`setStep(s => s - 1)`）
  - `step < 2`：`下一步`（校验失败则 `setError("请先填写想法")` / `setError("请选择一个模型渠道")` 不前进；通过则 `setMaxReached(m => Math.max(m, step + 1)); setStep(step + 1); setError("");`）
  - `step === 2`：现有「生成视频」提交按钮（`type="submit"`），沿用 `submit(e)` 原逻辑
- 顶部放 `<WizardSteps steps={STEPS} current={step} maxReached={maxReached} onJump={onJump} />`，置于 `<form>` 内最上方
- 保留现有 header 文案；`window.scrollTo({ top: 0 })` 在 `setStep` 后调用（长页面切步时回到顶部）

- [ ] **Step 3: 导航改名 + 设置页标题**

- `hf-studio/web/src/App.tsx:10`：`{ to: "/channels", label: "设置", end: false }`
- `hf-studio/web/src/pages/Channels.tsx`：`<h2>模型渠道</h2>` → `<h2>设置</h2>`；副文案改为「渠道配置：填入 Key 后点「获取模型」拉取该渠道全部模型，勾选需要的保存；Key 只存服务器、不回显。」；在 `presets` 网格前加 `<h3 className="text-sm font-semibold ...">渠道配置</h3>`（迁移自定义渠道段已有标题样式）

- [ ] **Step 4: 前端构建验证**

Run: `cd hf-studio/web && bun run build`
Expected: `tsc -b && vite build` 通过（无类型错误）

- [ ] **Step 5: 提交**

```bash
git add hf-studio/web/src/pages/NewJob.tsx hf-studio/web/src/components/WizardSteps.tsx hf-studio/web/src/App.tsx hf-studio/web/src/pages/Channels.tsx
git commit -m "feat: new task wizard (3 steps) + rename model channels nav to settings"
```

---

### Task 3: 渲染级验证（不花 LLM）

**目标**：证明「同款 chrome-headless-shell + 注入字体栈」前后，标题区从空心方块变为真实字形（墨迹密度对比），不改动任何仓库文件（脚本放 /tmp）。

**Files:**
- Create: `/tmp/cjk-verify/index.html`（两份：A=原样 `font-family:"system-ui",sans-serif`；B=同页替换为中文字体栈）——不提交
- Use: 渲染同款浏览器 `/root/.cache/hyperframes/chrome/chrome-headless-shell/linux-152.0.7928.2/chrome-headless-shell-linux64/chrome-headless-shell`

- [ ] **Step 1: 造两个对比页**

```bash
mkdir -p /tmp/cjk-verify
cat > /tmp/cjk-verify/a.html <<'EOF'
<!doctype html><html><head><meta charset="UTF-8"/><style>
#root { width: 1080px; height: 1920px; background: #fff; font-family: "system-ui", sans-serif; font-size: 72px; font-weight: 700; }
h1 { position: absolute; top: 1150px; left: 90px; width: 900px; }
</style></head><body><div id="root"><h1>太阳能，是地球最慷慨的能量之源。</h1></div></body></html>
EOF
sed 's/font-family: "system-ui", sans-serif/font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif/' /tmp/cjk-verify/a.html > /tmp/cjk-verify/b.html
```

- [ ] **Step 2: 同款浏览器截图 + 墨迹密度对比**

```bash
CH=/root/.cache/hyperframes/chrome/chrome-headless-shell/linux-152.0.7928.2/chrome-headless-shell-linux64/chrome-headless-shell
cd /tmp/cjk-verify
"$CH" --headless --no-sandbox --disable-gpu --window-size=1080,1920 --screenshot=a.png "file://$PWD/a.html" 2>/dev/null
"$CH" --headless --no-sandbox --disable-gpu --window-size=1080,1920 --screenshot=b.png "file://$PWD/b.html" 2>/dev/null
python3 - <<'EOF'
from PIL import Image
for name in ("a", "b"):
    im = Image.open(f"/tmp/cjk-verify/{name}.png").convert("L").crop((90, 1150, 990, 1400))
    px = list(im.getdata())
    dark = sum(1 for v in px if v < 128)
    print(f"{name}: 标题区暗像素 {dark} / {len(px)} = {dark/len(px):.4f}")
EOF
```
Expected: b 的暗像素比例显著大于 a（真实字形笔画密集 ≫ 空心方块边框），例如 b > 3× a；若 PIL 缺失，改用 `ffmpeg -vf signalstats` 的 YAVG 对比（b 更暗）。

- [ ] **Step 3: 交付汇报**

整理验证结论（a/b 密度数字）写进任务完成说明；`/tmp/cjk-verify` 属临时产物，无需清理（/tmp 自动回收），不留仓库。

---

## Self-Review

- **Spec 覆盖**：§3 乱码修复 → Task 1（util+step4+step5+prompt+单测）；§4 向导 → Task 2（3 步面板+步骤条+汇总卡+校验+导航改名+设置页标题）；§3.3 验证 → Task 3（像素密度对比）。✔
- **占位扫描**：无 TBD；每步含可执行代码/命令。✔
- **类型一致**：`ensureCjkFontStack` 签名在 Task 1 与测试中一致；`WizardSteps` props 在 Task 2 组件与用法一致；`finalModel` / `setStep` / `maxReached` 命名前后一致。✔
---

### Task 4（追加，实现期根因发现）: 子合成渲染韧性契约（视频空白根因修复）

**背景（实现期实证，已用同款 chrome-headless-shell + 真实 hyperframes 渲染验证）**：导出视频时**子合成 GSAP 时间线不被 seek** →
元素若按 gsap fromTo 从 `opacity:0` 起始（CSS 初始 hidden），导出定格在隐藏态 → 视频几乎全空白（用户"乱码"实为空白+残影）。
实测矩阵：mini（根合成动画）✅、tB（子合成动画）❌、tB2（+clip 属性）全部❌。clip 窗口机制会把窗口外元素隐藏，加剧问题。

**Files:**
- Modify: `hf-studio/server/src/util/clean-output.ts`（新增 `stripClipAttrs` 导出）
- Modify: `hf-studio/server/src/pipeline/steps/step4-build.ts`（写盘链追加 stripClipAttrs）
- Modify: `hf-studio/server/src/pipeline/steps/step5-validate.ts`（同上）
- Modify: `hf-studio/server/src/prompts/build-beat.txt`（动画契约重写，见下）
- Create/Modify: `hf-studio/server/test/clean-output.test.ts`（stripClipAttrs 单测）

**动画契约（build-beat.txt 重写的第 4/5 条替代内容——逐字使用）：**
```
4. 动画：完全由 gsap 时间线驱动，位置用片段本地秒（0..data-duration）。
   - 所有动画元素 CSS 初始态 = 可见终态（opacity:1、transform:none）——导出时子合成时间线可能不 seek，
     内容必须"不靠时间线也完整可见"；
   - 所有 fromTo 必须携带 immediateRender:false（g s a p 不会在构建时应用隐藏起点）；
   - 禁止 class="clip" 与 data-start/data-duration/data-track-index（只属于宿主槽位，子合成内使用会
     触发平台 clip 窗口机制，窗口外元素被隐藏）；
   - 用 fromTo 而非 from；禁止 repeat:-1 / 渲染时钟 / Math.random() / 网络请求 / gsap 操作片段外元素。
5. 脚本安全（挂载期不得抛错）：
   - 脚本第一行：window.__timelines = window.__timelines || {};（子合成脚本可能先于宿主脚本执行）；
   - DOM 查询用本片段唯一的类/ID（前缀 beat-N-），禁止 "#root …" 全局前缀选择（文档中存在多个 #root，
     首个是宿主根，会查到 null）；
   - 对任何 querySelector 结果先判空再使用（元素缺失则跳过，不得抛 TypeError）；textContent 赋值前判空。
```

（注：task-1-brief 中"第 9 条字体声明"等已提交内容不动；本条只改动画契约段与脚本安全段。）

**stripClipAttrs 实现（clean-output.ts）：**
```ts
/** 子合成（beat）内部禁止 clip 属性：class="clip" 与 data-start/data-duration/data-track-index
 * 只属于宿主槽位（index.html）。实测：子合成内使用 clip 属性触发平台窗口机制，窗口外元素被隐藏，
 * 导出视频大面积空白。本函数把这些属性从 beat HTML 中剥掉（宿主槽位由 root-html.ts 单独生成，不受影响）。 */
export function stripClipAttrs(html: string): string {
  // 1) 从 class 值中移除 "clip"
  let out = html.replace(/class="([^"]*)\bclip\b([^"]*)"/g, (_m, pre, post) => {
    const merged = (pre + " " + post).replace(/\s+/g, " ").trim();
    return merged ? `class="${merged}"` : "";
  });
  // 2) 移除 data-start / data-duration / data-track-index（根元素的 data-composition-id/width/height 保留）
  out = out.replace(/\s*data-(?:start|duration|track-index)="[^"]*"/g, "");
  return out;
}
```
step4/step5 写盘：`writeFileSync(file, stripClipAttrs(ensureCjkFontStack(stripCodeFences(content))))`（顺序：剥围栏→字体栈→剥 clip）。

**单测（追加到 clean-output.test.ts）：**
```ts
describe("stripClipAttrs", () => {
  test("剥掉 class='clip' 与 data-* 时间属性", () => {
    const src = `<div id="root" data-composition-id="beat-1" data-width="1080" data-height="1920" data-duration="2.925"><div class="clip title-wrap" data-start="0.8" data-duration="1.8" data-track-index="5">标题</div></div>`;
    const out = stripClipAttrs(src);
    expect(out).not.toContain("clip");
    expect(out).not.toContain("data-start");
    expect(out).not.toContain("data-track-index");
    // 根元素 data-duration 也会被剥（子合成根不需要）；composition-id/width/height 保留
    expect(out).toContain('data-composition-id="beat-1"');
    expect(out).toContain('data-width="1080"');
  });
  test("class 多值里 clip 移除后保留其余类", () => {
    expect(stripClipAttrs(`<div class="clip title-wrap">`)).toBe(`<div class="title-wrap">`);
    expect(stripClipAttrs(`<div class="title-wrap clip">`)).toBe(`<div class="title-wrap">`);
  });
  test("无 clip 的输入原样返回（属性剥离除外）", () => {
    const out = stripClipAttrs(`<div class="a" data-x="1">`);
    expect(out).toBe(`<div class="a" data-x="1">`);
  });
});
```
