#!/usr/bin/env bash
# cleanup-vendor.sh — 还原 vendor-shared.sh 的改写，严禁使用 git checkout -- src
set -euo pipefail
cd "$(dirname "$0")/.."

for f in $(find src -name "*.ts" -not -path "src/vendor/*"); do
  perl -pi -e 's{".*vendor/shared/index.js"}{"\@maestro-mobile/shared"}g' "$f"
done
rm -rf src/vendor
