# 新建任务向导 + 中文渲染字体修复 设计文档

> 日期：2026-08-05
> 状态：已确认（用户勾选"方案 OK，开干"）
> 范围：① 视频中文乱码（方块）根因修复；② 新建任务 3 步向导化；③ 导航「模型渠道」改名「设置」

## 1. 目标

1. **修中文乱码**：生成视频里中文渲染成方块/空白（`□`）。根因已实证：composition 使用 LLM 生成的 `font-family: "system-ui", sans-serif`，该字体栈在服务端 fontconfig 命中 DejaVu Sans（不含中文），`fc-match "Noto Sans CJK SC"` 才能命中 CJK 字体 → headless 渲染出无字形方块。数据层（HTML/transcript/字体文件）全部正常。
2. **新建任务向导化**：现「新建任务」把内容/模型/素材三块挤在一屏，改为顶部步骤条的 3 步向导，每步一页 + 上一步/下一步。
3. **导航改名**：「模型渠道」→「设置」，路由不变；「渠道配置」成为设置页内主板块，为未来设置项留位置；导航总数保持 3 项。

## 2. 已确认决策

| 决策点 | 结果 |
|--------|------|
| 乱码形态 | 用户确认是方块/空白（非拉丁乱码），与字体回退根因吻合 |
| 修复方式 | 纯项目内代码+提示词修复，**不改宿主机**（不装字体、不动 fontconfig） |
| 向导步数 | 3 步：① 内容设置 → ② 模型 → ③ 素材与确认 |
| 步骤条交互 | 顶部水平步骤条，可点击回跳已填步骤；底部 上一步/下一步 |
| 末步提交 | 第 3 步含素材上传 + 全部配置汇总 + 「生成视频」按钮 |
| 每步校验 | ①想法必填；②渠道必选；③素材可选 |
| 导航 | 「模型渠道」改名「设置」（`/channels` 路由不变） |

## 3. 乱码修复设计（服务端）

### 3.1 根因证据链

- 合成 HTML 中文内容正常（UTF-8，含 `<meta charset="UTF-8">`）
- 渲染同款 chrome-headless-shell 做 `--dump-dom`：DOM 解码正常
- 系统装有 Noto Sans/Serif CJK 全套（`fc-list :lang=zh` 30 条）
- **`fc-match "sans-serif" :lang=zh` 返回空；`fc-match "system-ui" :charset=4e00` 返回空；`fc-match "Noto Sans CJK SC"` 命中 `NotoSansCJK-Regular.ttc`**
- 结论：fontconfig 对泛型栈的 CJK 强绑定缺失 → Chromium 回退失败 → 方块

### 3.2 修复落点

1. **确定性注入**（主要防线）：`step4-build.ts` 写盘前（`stripCodeFences` 之后）对每个 beat HTML 后置注入一条 `#root` 规则：
   ```css
   #root { font-family: "Noto Sans CJK SC", "Noto Sans CJK JP", "PingFang SC",
           "Microsoft YaHei", "Hiragino Sans GB", "WenQuanYi Micro Hei", sans-serif; }
   ```
   - 追加在样式尾部、同一特异性、后声胜出 → 覆盖 LLM 的泛型栈；页面级显式字体（如装饰性西文字体）仍按更高特异性生效
   - 该写入点在 `step4-build.ts:91`（`writeFileSync(file, stripCodeFences(content))`），封装为新 util `ensureCjkFontStack(html)`（放 `server/src/util/cjk-font.ts`），带单测
2. **源头防线**：更新 `server/src/prompts/build-beat.txt`，要求 LLM 产出中文字体栈（Noto Sans CJK SC / PingFang SC / Microsoft YaHei / sans-serif），并允许西文装饰字体按元素使用
3. **step5 修复循环同理**：若 step5 会重写 composition，同样走 `ensureCjkFontStack`（实现时确认）

### 3.3 验证（不依赖肉眼）

- 单测：`ensureCjkFontStack` 注入/去重/保留元素字体
- 重渲染验证：对修复前后帧的标题区做墨迹像素统计（真实汉字笔画密度 ≫ 空心方块边框密度），对比阈值
- 浏览器级：`fc-match` 确认注入后的 family 名可命中

## 4. 新建任务向导设计（前端）

### 4.1 结构（`web/src/pages/NewJob.tsx` 重构 + 新组件 `WizardSteps`）

```
┌───────────────────────────────────────┐
│  ① 内容设置     ② 模型      ③ 素材与确认 │  ← 步骤条（点击已填步骤可回跳）
├───────────────────────────────────────┤
│  [当前步骤内容面板]                      │
│                                        │
├───────────────────────────────────────┤
│       [上一步]        [下一步 / 生成视频] │
└───────────────────────────────────────┘
```
- 步骤 1：想法 textarea（必填）+ 时长/画幅/配音/语言/音色（现状控件原样迁移）
- 步骤 2：渠道卡片选择 + 模型下拉 + 「临时自定义渠道」折叠（原样迁移）
- 步骤 3：素材上传（可选）+ 配置汇总卡（想法摘要、时长/画幅/配音、渠道/模型）+ 「生成视频」
- 状态：单组件内 state 保留（跨步骤不丢）；步骤校验不通过时「下一步」给出错误提示不前进
- 提交：复用现有 `createJob(form)` 逻辑

### 4.2 导航改名

- `App.tsx`：`NAV` 中 `{ to: "/channels", label: "设置" }`（路由/元素不变）
- `Channels.tsx`：页面标题「模型渠道」→「设置」，主板块标题「渠道配置」；副文案微调；卡片/交互全部不动

## 5. 影响面与不动项

- 后端 API / 数据格式 / 流水线步骤：**零改动**（仅 step4 写盘处理 + 提示词）
- `unconfig` 路由、任务列表、详情页：不动
- 宿主环境：不动（无安装、无配置修改）

## 6. 测试与验收

1. `bun test`（server）全绿（新增 cjk-font 单测 + 既有 90 项）
2. 前端 `bun run build` 通过
3. 重渲染一版验证：对比修复前后标题区墨迹像素密度（方块→字形）
4. 浏览器访问公网地址手工走一遍向导 3 步 + 提交，确认导航「设置」入口正常