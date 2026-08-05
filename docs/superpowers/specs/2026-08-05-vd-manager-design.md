# vd 管理工具设计文档 — HF-Studio 终端管理器

> 日期：2026-08-05
> 状态：已确认（用户逐项评审通过，含迁移设计 v2）
> 位置：`hf-studio/vd.ts` + 符号链接 `/usr/local/bin/vd`（宿主机变更，用户已批准）

## 1. 目标

用户在终端输入 `vd` 进入管理工具：
- 输入 `1` 启动项目（一条龙：检测依赖 → 影响宿主机的操作先询问 → 启动前后端 → 弹出访问地址 → 回菜单）
- 输入 `2` 停止项目
- 菜单页常驻显示运行状态：`RUN`（旁显示访问地址）或 `STOP`

## 2. 已确认的决策

| 决策点 | 结果 |
|--------|------|
| PATH 集成 | `/usr/local/bin/vd` 符号链接 → `hf-studio/vd.ts`（用户已批准宿主机变更） |
| 启动范围 | 前后端一起：后端 API :8787 + 前端 Vite :5173 |
| 界面语言 | 中文 |
| 迁移性 | 脚本自定位（`readlink -f`），项目根 = 脚本所在目录，零硬编码绝对路径；新服务器首次运行 = 完整一条龙 |

## 3. 菜单与状态

```
╭─ HF-Studio 管理工具 ───────────────────╮
│ 状态: RUN · 前端 http://localhost:5173   │
│       后端 http://localhost:8787         │
│  1. 启动项目                             │
│  2. 停止项目                             │
│  0. 退出                                │
╰─────────────────────────────────────────╯
```

- **状态判定**：状态文件中记录的 PID 存活（`kill -0`）+ 后端 `/api/health` 健康检查 → `RUN`；进程死亡则自动清理状态并显示 `STOP`。`RUN` 用绿色、`STOP` 用灰色（ANSI）。
- 每次回到菜单都重新渲染状态。

## 4. 启动一条龙（幂等，每次 start 重跑）

| 检测项 | 缺则操作 | 是否询问（宿主机） |
|--------|---------|------------------|
| `vd` 自身在 PATH | 提示创建 `/usr/local/bin/vd` 符号链接 | ⚠️ 询问 |
| bun 运行时 | 提示安装（官方脚本，装到 ~/.bun） | ⚠️ 询问 |
| server/web 依赖（node_modules） | 项目内 `bun install` | 否（自动） |
| ffmpeg / ffprobe | 提示 `apt-get install -y ffmpeg`（需 root） | ⚠️ 询问 |
| Chrome Headless Shell | 提示 `hyperframes browser ensure`（下载到用户缓存） | ⚠️ 询问 |
| config.json 的 LLM key | 缺失/占位 → 提示引导（不阻塞，可用前端自定义渠道） | 否（仅提示） |
| 端口 8787 / 5173 占用 | 提示冲突并中止启动 | 提示 |

- 所有"询问"默认 `[y/N]`，用户选择安装/跳过；跳过可能导致启动后功能不完整（如无 ffmpeg 无法渲染），提示里说明后果。
- 依赖就绪 → 后台启动（`detached` + 进程组），PID 与地址写入 `.tmp/vd-state.json`（gitignored），stdout/stderr 进 `.tmp/logs/backend.log` / `.tmp/logs/frontend.log`。
- 健康检查（后端 `/api/health`、前端端口 HTTP 200，最多等 ~60s）→ 通过后弹出访问地址 → 回车回菜单。
- 已处于 RUN 时输入 1 → 提示已运行（不重复启动）。

## 5. 停止

读状态文件 → 向进程组发 SIGTERM（`kill -<pid>` 负号）→ 等退出（~5s）→ 未退出则 SIGKILL → 清理状态文件 → 回菜单。已停止时输入 2 → 提示未运行。

## 6. 迁移行为（新服务器）

1. 复制项目目录 → `ln -s <项目路径>/vd.ts /usr/local/bin/vd`（或首次运行 vd 时引导创建）
2. 输入 `vd` → `1` 启动 → 完整一条龙自动处理（bun/依赖/ffmpeg/Chrome/key 检测逐项跑，需宿主机操作处询问）
3. 无额外初始化步骤；数据目录（data/、.tmp/）随新环境自然重建

## 7. 实现结构（单文件 + 可测函数）

`hf-studio/vd.ts`（约 300 行）：
- `resolveProjectRoot()` — `realpathSync(process.argv[1])` 的目录
- `loadState() / saveState() / clearState()` — `.tmp/vd-state.json` 读写
- `isPidAlive(pid)` — `kill(pid, 0)`
- `checkHealth(url, timeoutMs)` — fetch 重试
- `runCmd(cmd, args)` — 检测类命令执行封装（可注入 mock）
- `checkDeps()` — 各项检测，返回需要询问的项目列表
- `promptYesNo(question)` — readline 封装
- `startProject() / stopProject()` — 进程组管理
- `renderMenu()` — 状态渲染
- `main()` — 菜单循环（`if (import.meta.main)`）

## 8. 测试

- `hf-studio/test/vd.test.ts`（bun test）：
  - 状态文件 save/load/clear 往返
  - `isPidAlive`（真 PID / 假 PID）
  - `checkHealth`（真/假端口）
  - 依赖检测判断逻辑（mock 命令执行器）
  - 集成：`startProject()` → 健康检查通过 → `stopProject()` → 进程消失（真实前后端，标记 integration）
- 菜单交互手动验收

## 9. 宿主机影响汇总（全部经确认/运行中提示）

- `/usr/local/bin/vd` 符号链接（已批准）
- 可选：bun 安装脚本（~/.bun）、apt ffmpeg、Chrome 缓存下载（均在运行中询问）
- 项目内：node_modules、.tmp/（gitignored）
