---
name: release
description: Prepare and cut a release for this repository — verify the worktree, run checks, bump versions, auto-generate release notes from Conventional Commits into CHANGELOG.md, commit, tag, and push. Also refreshes the GitHub-facing README hooks if release docs are stale. Use when the user wants to 发布/发版/release/cut a version, or asks to 自动生成发版文档.
argument-hint: "[patch|minor|major] [--yes] [--notes-only]"
---

# Release

## Overview

Cut a release for pi-maestro-app-party: verify, bump, generate release docs from commits, tag and push. The mechanical core lives in `scripts/release.mjs`; this skill adds judgment (doc quality, release-readiness review) around it.

## Usage

```bash
$release                # 询问递进类型后执行
$release patch          # 直接 patch 发版
$release minor --yes    # 跳过确认
$release --notes-only   # 只重新生成/校对发版文档, 不打 tag
```

## Workflow

### 1. Release-readiness review (judgment layer)

Before running the script, check the things it cannot:

1. `git log --oneline <last-tag>..HEAD` — does the change set actually warrant this bump type? Breaking change → major; new feature → minor; fixes only → patch.
2. README quick-start still works? (deps changed → re-verify install steps)
3. CHANGELOG "已知限制" section still accurate?
4. Version fields consistent across `package.json` files and `apps/mobile/app.json`?

### 2. Run the release script

```bash
node scripts/release.mjs <patch|minor|major> [--yes]
```

The script does: clean-worktree check → branch check → `pnpm typecheck && pnpm test` → bump all versions (root/host/mobile/shared `package.json` + `app.json`) → generate CHANGELOG section from Conventional Commits (groups 新增/修复/文档/…, skips release/odyssey/chore-deps noise) → commit `release: v<x.y.z>` → tag → push with tags.

### 3. Post-release

1. `git log --oneline -3` and `git tag --list 'v*'` confirm.
2. If the repo has GitHub Releases enabled, draft one from the new CHANGELOG section:
   `gh release create v<x.y.z> --title "v<x.y.z>" --notes-file <(sed -n '/## \[<x.y.z>\]/,/## \[/p' CHANGELOG.md | sed '$d')`
3. For app builds, point the user at README 构建安装包 section (APK / iOS simulator) — builds are not part of this skill.

### Notes-only mode (`--notes-only`)

Dry-run of the doc pipeline: print the grouped change list that *would* be written (`node scripts/release.mjs --changelog-only`), update CHANGELOG Unreleased if asked, but never bump/tag/push.

## Failure handling

- Script dies on dirty worktree / non-main branch / failing tests — fix and re-run, never bypass.
- Push failure (no remote / auth): commit+tag already exist locally; report and let the user push manually.
- CHANGELOG link-footer mismatches: fix manually; the script's regex assumes the standard Keep-a-Changelog footer.
