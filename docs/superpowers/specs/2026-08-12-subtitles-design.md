# 硬字幕烧录（按 beat 整句 + 跟随主题）设计文档

> 日期：2026-08-12
> 状态：已确认（用户逐节评审通过：方案 A 烧录 / 默认开启 / step6 渲染后立即执行）
> 范围：渲染完成后用 ffmpeg ASS 烧录旁白字幕，样式跟随 DESIGN 主题

## 1. 背景与决策

transcript.json（词级时间轴）在 step3 已生成但未渲染，视频无字幕。本次让成片直接可看（打开 MP4 即带中文旁白字幕）。

| 决策点 | 结果 |
|--------|------|
| 呈现形式 | **硬字幕烧进视频**（ffmpeg ASS 烧录，二次编码） |
| 视觉风格 | **跟随 DESIGN 主题**（主色文字 + 描边 + 半透明底），取色失败兜底白色 |
| 时间粒度 | **按 beat 整句**：每个 beat 显示整段旁白，时间窗与 beat 起止对齐 |
| 开关 | `JobConfig.subtitles`，**默认 true（开启）**；前端新建任务向导加开关（默认开，配音关闭时禁用） |
| 烧录时机 | **step6 渲染成功后立即烧录**，再对最终产物执行 probe 门校验 |

环境已验证：ffmpeg 带 `--enable-libass --enable-libfontconfig`，`subtitles`/`ass` filter 可用；`Noto Sans CJK SC` 已安装（fc-list 可解析）。

## 2. 数据流

- 输入：step2 的 `beats[].narration`（整句）+ step3 的 `boundaries`（真实起止；软目标收尾后最后一个 beat 的 endSec 已延长）→ 每 beat 一条字幕
- 新增纯函数模块 `server/src/subtitle/ass.ts`：`buildAss(dialogues, style)` 生成 ASS（Script Info / Styles / 每 beat 一条 Dialogue，时间格式化 HH:MM:SS.cc）
- 烧录命令（step6 内）：
  ```
  ffmpeg -y -i output.mp4 -vf ass=subs.ass -c:v libx264 -crf 18 -preset fast -c:a copy output.sub.mp4
  mv output.sub.mp4 output.mp4
  ```
- 无配音模式（`voiceover=false`）：无旁白文本，跳过烧录

## 3. 样式规则（跟随主题）

- 取色优先级：`config.theme.hue.primary`（用户给定值）→ DESIGN.md Quick Reference 首个 HEX → 兜底白色
- 字体：`Noto Sans CJK SC`；字号约屏高 6%；白描边 + 半透明黑底保证可读性
- 位置：底部居中，MarginV 约屏高 5%（PlayResX/Y 用 `RESOLUTIONS[format]`）

## 4. 时机与错误处理

- step6：`ctx.render.render()` 成功后立即烧录；烧录成功则对最终文件执行 probe 门校验（时长/视频流）
- **烧录失败不判任务失败**：保留无字幕 output.mp4，log 警告后仍通过（字幕是增强项，不阻塞成片）

## 5. 测试

- 单测：`buildAss` 输出合法 ASS（头部/Style/Dialogue 时间格式/颜色）、取色优先级逻辑（theme → DESIGN.md → 兜底）
- 集成：用 ffmpeg 生成 1s 测试视频验证烧录产出存在 + 时长不变
- E2E：真实任务产物含烧录字幕、无回归

## 6. 影响面

- 后端：`server/src/types.ts`（JobConfig.subtitles）、`api/server.ts`（解析 subtitles）、`step6-render.ts`（烧录 + 门）、新增 `server/src/subtitle/ass.ts`
- 前端：`web/src/pages/NewJob.tsx`（字幕开关）、`web/src/pages/JobDetail.tsx`（展示）、`web/src/types.ts`
- 测试：`subtitle/ass.test.ts`、`step6-render.test.ts` 扩展
