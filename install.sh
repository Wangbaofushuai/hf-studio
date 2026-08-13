#!/usr/bin/env bash
# HF-Studio 一键安装脚本
#
# 用法（任选一行）：
#   curl -fsSL https://raw.githubusercontent.com/Wangbaofushuai/hf-studio/main/install.sh | bash
#   bash <(curl -fsSL https://raw.githubusercontent.com/Wangbaofushuai/hf-studio/main/install.sh)
#
# 行为：
#   1. 克隆仓库到 ~/hf-studio（可用环境变量 HF_STUDIO_DIR 覆盖）
#   2. 创建 /usr/local/bin/vd 软链接（无权限则用 sudo，再不行退到 ~/.local/bin）
#   3. 检测 bun（其余依赖由 vd 首次启动时一条龙检测/安装）
#
# 卸载：rm -rf "$HOME/hf-studio" /usr/local/bin/vd
set -e

REPO_URL="${HF_STUDIO_REPO:-https://github.com/Wangbaofushuai/hf-studio.git}"
INSTALL_DIR="${HF_STUDIO_DIR:-$HOME/hf-studio}"
VD_LINK="/usr/local/bin/vd"

GREEN='\033[32m'; DIM='\033[90m'; RESET='\033[0m'; BOLD='\033[1m'
info() { echo -e "${DIM}==>${RESET} $*"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
err()  { echo -e "✗ $*" >&2; exit 1; }

echo -e "${BOLD}HF-Studio 安装器${RESET}"
info "安装目录: $INSTALL_DIR"

# 1) 前置检查
command -v git >/dev/null 2>&1 || err "未检测到 git，请先安装：apt-get install -y git"

# 2) 克隆 / 更新仓库（幂等：已存在则 pull）
if [ -d "$INSTALL_DIR/.git" ]; then
  info "已存在仓库，执行更新（git pull）"
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "克隆仓库（浅克隆）"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# vd.ts 定位：仓库根即 hf-studio（本仓库结构 = 根下含 hf-studio/ 子目录）
if [ -f "$INSTALL_DIR/hf-studio/vd.ts" ]; then
  VD_FILE="$INSTALL_DIR/hf-studio/vd.ts"
  APP_DIR="$INSTALL_DIR/hf-studio"
elif [ -f "$INSTALL_DIR/vd.ts" ]; then
  VD_FILE="$INSTALL_DIR/vd.ts"
  APP_DIR="$INSTALL_DIR"
else
  err "未找到 vd.ts（仓库结构异常）"
fi

# 5) 确保本地配置存在（gitignored，新克隆无此文件 → 从模板重建，否则预设渠道列表为空）
CONFIG_JSON="$APP_DIR/server/config.json"
CONFIG_EXAMPLE="$APP_DIR/server/config.example.json"
if [ ! -f "$CONFIG_JSON" ] && [ -f "$CONFIG_EXAMPLE" ]; then
  cp "$CONFIG_EXAMPLE" "$CONFIG_JSON"
  ok "已从 config.example.json 创建 server/config.json（预设渠道）"
fi

# 3) 创建 vd 快捷命令
info "创建 vd 快捷命令"
if ln -sf "$VD_FILE" "$VD_LINK" 2>/dev/null; then
  ok "$VD_LINK → $VD_FILE"
elif command -v sudo >/dev/null 2>&1 && sudo ln -sf "$VD_FILE" "$VD_LINK" 2>/dev/null; then
  ok "$VD_LINK → $VD_FILE（sudo）"
else
  info "/usr/local/bin 无写权限，回退到 ~/.local/bin/vd（请确保 PATH 含 ~/.local/bin）"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$VD_FILE" "$HOME/.local/bin/vd"
  VD_LINK="$HOME/.local/bin/vd"
  ok "$VD_LINK → $VD_FILE"
fi

# 4) bun 检测（vd 首启会引导安装，这里仅提示）
if ! command -v bun >/dev/null 2>&1; then
  info "未检测到 bun —— vd 首次启动时会引导安装（curl -fsSL https://bun.sh/install | bash）"
fi

echo
echo -e "${GREEN}✅ 安装完成！${RESET}"
echo -e "   输入 ${BOLD}vd${RESET} 进入 HF-Studio 管理面板（首次启动自动检测/安装 ffmpeg、Chrome、CJK 字体等依赖）"
echo -e "   更新:   vd 菜单选「更新」或重新执行本脚本"
echo -e "   卸载:   rm -rf $INSTALL_DIR $VD_LINK"
