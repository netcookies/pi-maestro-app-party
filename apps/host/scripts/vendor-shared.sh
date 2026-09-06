#!/usr/bin/env bash
# vendor-shared.sh — 把 packages/shared 源码同步到 src/vendor 并改写引用（编译期专用）
# 用途：build.sh 与 typecheck 共用；调用方负责结束后 git checkout -- src && rm -rf src/vendor
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf src/vendor
mkdir -p src/vendor/shared
cp ../../packages/shared/src/*.ts src/vendor/shared/

# 改写引用：@maestro-mobile/shared → 相对 vendor 路径（按 f 中斜杠数）
# macOS bash 3.2 不支持 [^/]；pipefail 下 grep 无匹配会死 —— 用 tr -cd（无匹配也 exit 0）
for f in $(find src -name "*.ts" -not -path "src/vendor/*"); do
  slashes=$(printf '%s' "$f" | tr -cd '/')
  # src/x.ts → 1 斜杠 → ./vendor；src/pi/x.ts → 2 → ../vendor
  case "${#slashes}" in
    1) prefix="." ;;
    2) prefix=".." ;;
    3) prefix="../.." ;;
    *) prefix="../../.." ;;
  esac
  perl -pi -e "s{\"\\@maestro-mobile/shared\"}{\"$prefix/vendor/shared/index.js\"}g" "$f"
done
