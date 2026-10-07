#!/usr/bin/env bash
# cleanup-vendor.sh — restore only vendor imports; never use git checkout -- src.
set -euo pipefail
cd "$(dirname "$0")/.."

for f in $(find src -name "*.ts" -not -path "src/vendor/*"); do
  # Exact quoted import forms only, preserving unrelated source and user edits.
  perl -pi -e 's{"(?:\.\./|\./)*vendor/shared/index\.js"}{"\@maestro-mobile/shared"}g' "$f"
  perl -pi -e 's{"(?:\.\./|\./)*vendor/mobile-sdk/protocol/index\.js"}{"\@maestro-mobile/mobile-sdk/protocol"}g' "$f"
done
rm -rf src/vendor
