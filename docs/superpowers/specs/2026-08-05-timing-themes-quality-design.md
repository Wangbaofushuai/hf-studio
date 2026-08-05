# 音画对齐 + 主题模板 + 时长软目标 + 质量提升 设计文档

> 日期：2026-08-05
> 状态：已确认（用户四问拍板：预设主题+色相微调 / 质量全部方面 / 15·30·60·90+自定义软目标 / 默认横屏+明示分辨率）
> 范围：① 音画不同步修复；② 默认画幅与分辨率明示；③ 主题预设 + 色相微调；④ 质量全面提升

## 1. 问题与根因（已实证）

| # | 现象 | 证据 | 根因 |
|---|------|------|------|
| 1 | 配音没说完视频就结束 | VO 12.6s vs 视频 10.3s；18.26s vs 16.53s | TTS 词级时间戳不含句尾静音，`synthesizeToWav` 返回的 `durationSec` 与 `buildBeatBoundaries` 都用**词级末尾**，低估真实音频 → 视频边界提前 |
| 2 | 选 16:9 却出竖屏 | 链路代码正确（format→RESOLUTIONS→data-resolution 全通）| 两个任务均为表单**默认 portrait** 创建；默认值与界面缺少分辨率明示 |
| 4 | 质量差 | 提示词结构合规但执行平庸 | 生成端低档思考 + 提示词缺反平庸质量红线 + 渲染无高清档 + 无 beat 级质量门 |

## 2. 已确认决策

| 决策点 | 结果 |
|--------|------|
| 主题形式 | **预设 6 主题卡片 + 每主题色相微调**（主色/强调色），另保留"自由发挥"；选中注入 design/storyboard 生成 |
| 质量范围 | 视觉/文字/动画/整体全面提（多选） |
| 时长 | 预设 15/30/60/90s + 自定义 5-240s；**软目标**：视频时长 ≈ 目标 ±20%，缺的用结尾停留补，旁白长于目标以旁白为准 |
| 默认画幅 | 默认横屏 16:9；汇总卡与详情明示分辨率（1920×1080 / 1080×1920 / 1080×1080） |
| 清晰度 | 新增渲染清晰度选项（标准 / 高清 high） |

## 3. 音画对齐 + 软目标时长（服务端）

### 3.1 真实时长来源
- 所有 beat wav 与拼接后 narration.wav 用 `probeMedia()`（ffprobe）取**真实秒数**；取代词级末尾。
- `synthesizeToWav` 的 `durationSec` 语义不变（仍供 TTS 门），但**边界计算不再用它**。

### 3.2 边界公式（step3）
```
real[i] = ffprobe(assets/narration-beat-i.wav).durationSec
gap = 0.25s（beat 间呼吸间隙，提高"节奏感"）
boundary[i].endSec = boundary[i-1].endSec + real[i] + (i>0 ? gap : 0)
totalReal = last boundary end
```
- transcript（词级对齐）保留使用，供后续字幕/校验——但它不再是视频边界来源。
- step3 时长门改为真实值：`|totalReal - estimateTotal| / estimateTotal > 30%` 才失败（防 TTS 产物损坏），并把估算与实际都写日志。

### 3.3 软目标收尾（step4）
```
target = config.durationSec
tailHold = max(0.6, min(target - totalReal, target * 0.5))     // 缺多少补多少，上限 50% 目标
lastBeat.endSec = max(lastBeat.endSec, totalReal + tailHold)     // 最后一个 beat 延续到结束
videoDuration ≈ max(totalReal + 0.6, totalReal + tailHold)
```
- 旁白短 → 视频略长于旁白到目标附近（±20% 可接受）；旁白长 → 视频=旁白+0.6s 结尾。
- root index.html 的总时长与 narration audio `data-duration` 同步用 `max(boundaryEnd, target)` 计算。

### 3.4 step2 门保持
- storyboard 时长/旁白 vs 目标 ±20% 门保留（它是"尽量符合"的第一道防线）。

## 4. 默认横屏 + 分辨率明示

- `NewJob.tsx`：`useState("landscape")`；FORMATS 标签带像素："横屏 16:9 · 1920×1080" / "竖屏 9:16 · 1080×1920" / "方形 1:1 · 1080×1080"。
- 向导第 3 步汇总卡与 `JobDetail` 显示：`格式 · 实际分辨率`；JobDetail 用 `RESOLUTIONS[format]` 或 ffprobe 结果展示。
- 后端无改动（链路已通）；**验证**：真实渲染一个 landscape 任务，ffprobe 确认 1920×1080。

## 5. 主题预设 + 色相微调

### 5.1 主题集（前端卡片，第 1 步）
| id | 名称 | 风格关键词（注入 design） |
|----|------|--------------------------|
| tech | 科技感 | 深蓝紫、霓虹渐变、网格线、数据感、高对比 |
| nature | 清新自然 | 米白/绿、柔和圆角、留白多、自然光照 |
| business | 商务极简 | 白/深灰/蓝、大字号、克制动效、权威感 |
| warm | 暖系知识 | 奶油/橙棕、圆润、亲和、教育感 |
| retro | 复古胶片 | 暖黄/锈红、颗粒噪点、衬线大字、年代感 |
| dark | 暗黑潮流 | 近黑底、荧光强调、大标题、霓虹边框 |

### 5.2 色相微调
- 每主题展开两个色板：**主色**、**强调色**（原生 `<input type="color">`）。
- 提交 `theme: { id: "tech", hue: { primary: "#xxxxxx", accent: "#xxxxxx" } }`；不调整则沿用主题默认或自由发挥。

### 5.3 数据流
- `JobConfig` 增 `theme?: { id: string; hue?: { primary?: string; accent?: string } }`；API `/api/jobs` 接收 `theme`（JSON 字符串）；`brief.json` 写入 intent 内；step1 的 user content 附《主题约束》段（主题关键词 + 色相值 + "主色/强调色必须采用给定值，其余色板按主题推导"）；step2 同注入。

## 6. 质量全面提升（提示词 + 档位）

- **design.txt**：加《质量红线》：禁止"白底+居中标"默认模板感；排版必须有信息层级；8-12 色含语义角色与对比度；字体角色明确；每小节给出可执行的 do/don't；色相微调时主/强调色固定为给定值。
- **build-beat.txt**：加《反平庸与细节质量》：每 beat 必须有视觉焦点与信息层级；禁止纯色卡+一句居中的"占位感"布局；动效至少两层且带运动感（非只有淡入淡出）：位移/缩放/路径/遮罩/粒子任选；字号/留白/对比按 DESIGN.md 严格执行；颜色、字体、圆角、阴影与 DESIGN.md 一致。
- **生成档位**：step4 build 与 step5 fix 的 `reasoningEffort` 从 `low` 升为 `medium`（实测质量显著提升；时间每 beat 约 1-2 分钟，可接受）。step6 渲染 `quality` 支持 `standard|high`，任务配置 `renderQuality` 注入。
- **前端**：新建任务加"清晰度"选项（标准 / 高清），随任务提交。

## 7. 影响面与验证

- 后端：`types.ts`(JobConfig)、`api/server.ts`(解析 theme/renderQuality)、`step0`(brief.json 不必要改,用 config 直接传)、`step1`、`step2`、`step3`、`step4`、`step6`、`beat-timing.ts`、`prompts/{design,build-beat}.txt`。
- 前端：`NewJob.tsx`（主题+色相+时长+画幅+清晰度）、`JobDetail.tsx`（分辨率/清晰度展示）、`types.ts`、`api.ts`。
- 测试：step3/step4 边界单测（真实 ffprobe mock）、主题请求解析测试、前端 build。
- 验收：全量测试绿 + 前端 build 通过 + **一次真实 E2E**（60s 横屏 + 科技主题）：ffprobe 断言 `1920×1080`、`视频时长 ≥ narr音频时长`（音画对齐）、时长落在目标的 ±25% 内、产物含主题色。