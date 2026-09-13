#!/usr/bin/env bash
# build.sh — 发布构建：shared 源码 vendored，产物完全自包含（无 workspace 依赖）
set -euo pipefail
cd "$(dirname "$0")"

bash scripts/vendor-shared.sh
# 必须先清空 dist：tsc 不会删除已从 src 移除的模块的旧产物
rm -rf dist
npx tsc

bash scripts/cleanup-vendor.sh

echo "build ok → dist/"
