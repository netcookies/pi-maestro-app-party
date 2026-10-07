#!/usr/bin/env bash
# vendor-shared.sh — stage Desktop contracts and the canonical SDK protocol for self-contained Host builds.
# The SDK client/runtime is intentionally excluded from the Host artifact.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf src/vendor
mkdir -p src/vendor/shared src/vendor/mobile-sdk/protocol
cp ../../packages/shared/src/*.ts src/vendor/shared/
cp ../../packages/mobile-sdk/src/protocol.ts src/vendor/mobile-sdk/protocol.ts
cp ../../packages/mobile-sdk/src/validation.ts src/vendor/mobile-sdk/validation.ts
cp ../../packages/mobile-sdk/src/timeline.ts src/vendor/mobile-sdk/timeline.ts
cp ../../packages/mobile-sdk/src/release.ts src/vendor/mobile-sdk/release.ts
cp ../../packages/mobile-sdk/src/mobile-plan-protocol.ts src/vendor/mobile-sdk/mobile-plan-protocol.ts
cp ../../packages/mobile-sdk/src/protocol/index.ts src/vendor/mobile-sdk/protocol/index.ts

# Rewrite workspace imports in Host source to the temporary staged files.
for f in $(find src -name "*.ts" -not -path "src/vendor/*"); do
  slashes=$(printf '%s' "$f" | tr -cd '/')
  case "${#slashes}" in
    1) prefix="." ;;
    2) prefix=".." ;;
    3) prefix="../.." ;;
    *) prefix="../../.." ;;
  esac
  perl -pi -e "s{\"\\@maestro-mobile/shared\"}{\"$prefix/vendor/shared/index.js\"}g" "$f"
  perl -pi -e "s{\"\\@maestro-mobile/mobile-sdk/protocol\"}{\"$prefix/vendor/mobile-sdk/protocol/index.js\"}g" "$f"
done

# The shared facade continues to resolve the exact same canonical SDK protocol source.
for f in src/vendor/shared/*.ts; do
  perl -pi -e 's{"\@maestro-mobile/mobile-sdk/protocol"}{"../mobile-sdk/protocol/index.js"}g' "$f"
done
