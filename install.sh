#!/usr/bin/env sh
# 便捷入口：等价于 node apply.mjs <命令>（默认 detect）
#   ./install.sh            环境检测（只读）
#   ./install.sh apply      自适应部署
#   ./install.sh revert     还原
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -eq 0 ]; then
  exec node "$DIR/apply.mjs" detect
fi
exec node "$DIR/apply.mjs" "$@"
