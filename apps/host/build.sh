#!/usr/bin/env bash
# build.sh — 发布构建：shared 源码 vendored，产物完全自包含（无 workspace 依赖）
set -euo pipefail
cd "$(dirname "$0")"

bash scripts/vendor-shared.sh
# 必须先清空 dist：tsc 不会删除已从 src 移除的模块的旧产物（实测：删掉
# ws-command-handlers.ts / jsonl-replay.ts 后，8 个陈旧 .js/.d.ts/.map 仍在 dist/ 里，
# 而 package.json files=["dist"] 会把它们随 npm publish 发布）。
# 不清同时还会使陈旧产物被误当有效验证目标。
rm -rf dist
npx tsc
git checkout -- src 2>/dev/null || true
rm -rf src/vendor

echo "build ok → dist/"
