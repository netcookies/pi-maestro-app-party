#!/usr/bin/env bash
# build.sh — 发布构建：shared 源码 vendored 进 src/vendor，产物完全自包含（无 workspace 依赖）
# 源码在构建后被还原（git checkout），vendored 副本仅在编译期存在。
set -euo pipefail
cd "$(dirname "$0")"

# 1. 同步 shared 源码到 vendor 目录（编译期专用）
rm -rf src/vendor
mkdir -p src/vendor/shared
cp ../../packages/shared/src/*.ts src/vendor/shared/

# 2. 改写引用：@maestro-mobile/shared → 相对 vendor 路径（按文件相对 src 的目录深度）
find src -name "*.ts" -not -path "src/vendor/*" | while read -r f; do
  sub="${f#src/}"
  depth=$(dirname "$sub" | grep -o "/" | wc -l)
  # 文件在 src 根：./vendor；一层目录：../vendor；两层：../../vendor
  case "$depth" in
    0) prefix="." ;;
    1) prefix=".." ;;
    2) prefix="../.." ;;
    *) prefix="../../.." ;;
  esac
  perl -pi -e "s{\"\\@maestro-mobile/shared\"}{\"$prefix/vendor/shared/index.js\"}g" "$f"
done

# 3. 编译
npx tsc

# 4. 还原源码 + 清理 vendor
git checkout -- src 2>/dev/null || true
rm -rf src/vendor

echo "build ok → dist/"
