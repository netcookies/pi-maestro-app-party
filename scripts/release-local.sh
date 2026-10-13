#!/usr/bin/env bash
# release-local.sh — 本地一键发布 Maestro Mobile（GitHub runner 限额时的备用通道）
#
# 用法：
#   scripts/release-local.sh <version> [--skip-npm] [--skip-apk] [--skip-ios]
#   例：scripts/release-local.sh 0.1.2
#
# 流程：预检 → 构建 APK（签名+混淆）→ 构建未签名 IPA → npm publish（可跳过）
#       → git tag → gh release create 上传产物
#
# 依赖：node/pnpm、JDK+Android SDK、Xcode、gh（已登录）、npm（已登录、2FA automation token）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-}"
SKIP_NPM=false; SKIP_APK=false; SKIP_IOS=false
for arg in "${@:2}"; do
  case "$arg" in
    --skip-npm) SKIP_NPM=true ;;
    --skip-apk) SKIP_APK=true ;;
    --skip-ios) SKIP_IOS=true ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

[[ -n "$VERSION" ]] || { echo "用法: $0 <version> [--skip-npm] [--skip-apk] [--skip-ios]"; exit 1; }
TAG="v$VERSION"
OUT_DIR="$REPO_ROOT/dist-release"
mkdir -p "$OUT_DIR"

note() { echo -e "\033[1;34m[release]\033[0m $*"; }
die()  { echo -e "\033[1;31m[release] FATAL:\033[0m $*" >&2; exit 1; }

# ── 预检 ────────────────────────────────────────────────────────────────
note "预检 v$VERSION"
command -v gh    >/dev/null || die "gh 未安装（brew install gh）"
command -v xcodebuild >/dev/null || die "Xcode 未安装"
gh auth status >/dev/null 2>&1 || die "gh 未登录（gh auth login）"
npm whoami >/dev/null 2>&1 || die "npm 未登录（npm login）"
# 已存在的 Release 允许重跑：正文会被统一更新，资产随后覆盖上传
[[ -f "$REPO_ROOT/apps/mobile/android/local.properties" ]] || die "缺 android/local.properties（签名配置），参考 docs/deploy.md"
git -C "$REPO_ROOT" diff --quiet || die "工作树有未提交改动，先 commit"
git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "本地已有 tag $TAG"
note "预检通过"

# ── 同步版本号（package.json / app.json / iOS Info.plist）──────────────
PREVIOUS_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
note "同步版本号为 v$VERSION"
node "$REPO_ROOT/scripts/bump-version.mjs" "$VERSION"
pnpm --filter @maestro-mobile/shared build

# CHANGELOG 必须先准备好，release-notes 生成器会拒绝不存在的版本段
node "$REPO_ROOT/scripts/release-notes.mjs" "$VERSION" --update --from "$PREVIOUS_VERSION" >/dev/null
note "CHANGELOG 已准备 v$VERSION 版本段"

# ── npm publish（host 包）───────────────────────────────────────────────
if [[ "$SKIP_NPM" == false ]]; then
  note "npm publish pi-maestro-mobile@$VERSION"
  (cd "$REPO_ROOT/apps/host" && npm publish --provenance) || die "npm publish 失败"
else
  note "跳过 npm publish"
fi

# ── APK ────────────────────────────────────────────────────────────────
if [[ "$SKIP_APK" == false ]]; then
  note "构建签名 release APK（混淆+资源收缩）"
  (cd "$REPO_ROOT/apps/mobile/android" && ./gradlew assembleRelease --no-daemon) || die "APK 构建失败"
  APK_SRC="$REPO_ROOT/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
  APK="$OUT_DIR/maestro-mobile-$VERSION.apk"
  cp "$APK_SRC" "$APK"
  BT="$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/build-tools/* | sort -V | tail -1)"
  "$BT/apksigner" verify --print-certs "$APK" | head -3
  note "APK ✓ $(du -h "$APK" | cut -f1)"
else
  note "跳过 APK"
fi

# ── iOS ────────────────────────────────────────────────────────────────
if [[ "$SKIP_IOS" == false ]]; then
  note "安装 iOS Pods"
  (cd "$REPO_ROOT/apps/mobile/ios" && \
    RUBYOPT="-r$PWD/cocoapods_pathname_workaround.rb" pod install --repo-update) || die "Pod 安装失败"
  note "构建未签名 IPA"
  (cd "$REPO_ROOT/apps/mobile/ios" && xcodebuild -workspace MaestroMobile.xcworkspace \
    -scheme MaestroMobile -configuration Release -sdk iphoneos -derivedDataPath build \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" | tail -2) || die "IPA 构建失败"
  APP="$(find "$REPO_ROOT/apps/mobile/ios/build/Build/Products/Release-iphoneos" -maxdepth 1 -name '*.app' | head -1)"
  rm -rf /tmp/Payload && mkdir -p /tmp/Payload && cp -R "$APP" /tmp/Payload/
  IPA="$OUT_DIR/MaestroMobile-unsigned-$VERSION.ipa"
  (cd /tmp && rm -f "$IPA" && zip -qry "$IPA" Payload)
  note "IPA ✓ $(du -h "$IPA" | cut -f1)"
else
  note "跳过 iOS"
fi

# ── git commit + tag ────────────────────────────────────────────────────
git -C "$REPO_ROOT" add -A
git -C "$REPO_ROOT" commit -m "release: $TAG" || die "release commit 失败"
git -C "$REPO_ROOT" tag -a "$TAG" -m "maestro-mobile v$VERSION"
note "commit + tag $TAG 已创建"

# ── GitHub Release ─────────────────────────────────────────────────────
note "创建 GitHub Release $TAG"
ASSETS=()
[[ -f "$OUT_DIR/maestro-mobile-$VERSION.apk" ]] && ASSETS+=("$OUT_DIR/maestro-mobile-$VERSION.apk")
[[ -f "$OUT_DIR/MaestroMobile-unsigned-$VERSION.ipa" ]] && ASSETS+=("$OUT_DIR/MaestroMobile-unsigned-$VERSION.ipa")
git -C "$REPO_ROOT" push origin "HEAD:$(git -C "$REPO_ROOT" branch --show-current)" "$TAG" || die "发布 commit/tag 推送失败（网络/权限）"

NOTES="$(node "$REPO_ROOT/scripts/release-notes.mjs" "$VERSION")"
if gh release view "$TAG" --repo netcookies/pi-maestro-app-party >/dev/null 2>&1; then
  note "Release $TAG 已存在，更新正文并补传产物"
  gh release edit "$TAG" --repo netcookies/pi-maestro-app-party \
    --title "Maestro Mobile v$VERSION" --notes "$NOTES" || die "gh release edit 失败"
else
  gh release create "$TAG" \
    --repo netcookies/pi-maestro-app-party \
    --title "Maestro Mobile v$VERSION" \
    --notes "$NOTES" "${ASSETS[@]}" || die "gh release create 失败"
  ASSETS=()
fi
if ((${#ASSETS[@]} > 0)); then
  gh release upload "$TAG" --repo netcookies/pi-maestro-app-party "${ASSETS[@]}" --clobber || die "gh release upload 失败"
fi

note "🎉 maestro-mobile v$VERSION 发布完成"
gh release view "$TAG" --repo netcookies/pi-maestro-app-party --web
