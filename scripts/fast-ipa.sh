#!/usr/bin/env bash
# fast-ipa.sh — 极速打包无签名 iOS IPA
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/apps/mobile"
APP_PATH="$MOBILE_DIR/ios/build/Build/Products/Release-iphoneos/MaestroMobile.app"
OUT_IPA="${1:-$HOME/Downloads/MaestroMobile-unsigned.ipa}"

# 如果没有原生编译产物，则先进行一次增量构建（利用 ios/build 缓存）
if [[ ! -d "$APP_PATH" ]]; then
  echo "首次检测到无 Release-iphoneos 产物，执行增量编译..."
  (cd "$MOBILE_DIR/ios" && xcodebuild -workspace MaestroMobile.xcworkspace \
    -scheme MaestroMobile -configuration Release -sdk iphoneos -derivedDataPath build \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" -quiet)
fi

echo "🚀 [1/3] 导出最新 JS Bundle 与资源..."
(cd "$MOBILE_DIR" && npx expo export:embed \
  --platform ios \
  --dev false \
  --entry-file node_modules/expo-router/entry.js \
  --bundle-output "$APP_PATH/main.jsbundle" \
  --assets-dest "$APP_PATH")

echo "⚡ [2/3] Hermes AOT 字节码优化..."
HERMES_BIN="$MOBILE_DIR/ios/Pods/hermes-engine/destroot/bin/hermesc"
if [[ -f "$HERMES_BIN" ]]; then
  "$HERMES_BIN" -emit-binary -max-diagnostic-width=80 -O \
    -out "$APP_PATH/main.jsbundle.hbc" "$APP_PATH/main.jsbundle"
  mv "$APP_PATH/main.jsbundle.hbc" "$APP_PATH/main.jsbundle"
fi

echo "📦 [3/3] 压缩生成无签名 IPA..."
TMP_PAYLOAD="/tmp/fast_ipa_payload"
rm -rf "$TMP_PAYLOAD" && mkdir -p "$TMP_PAYLOAD/Payload"
cp -R "$APP_PATH" "$TMP_PAYLOAD/Payload/"
(cd "$TMP_PAYLOAD" && zip -qry "$OUT_IPA" Payload)
rm -rf "$TMP_PAYLOAD"

echo "✅ 搞定！产物位置: $OUT_IPA"
ls -lh "$OUT_IPA"
