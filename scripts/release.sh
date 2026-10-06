#!/usr/bin/env bash
# MakeMovie 一键发版：打标签 → 推标签（CI 自动构建发布三镜像到 ghcr）→ 建 Release。
# 用法：scripts/release.sh v0.2.0 [notes.md]
#   notes.md 缺省时生成模板到 /tmp 并用 $EDITOR 打开（外宣边界：能力向前，
#   不写内部信息/过程信息/弱点措辞——见 docs/promotion-plan.md 与团队规则）。
set -euo pipefail

repo="DreamOfXM/makemovie"
version="${1:?用法: scripts/release.sh v0.2.0 [notes.md]}"
notes="${2:-}"

[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号须形如 v0.2.0"; exit 1; }
git rev-parse "refs/tags/$version" >/dev/null 2>&1 && { echo "标签 $version 已存在"; exit 1; }
git diff-index --quiet HEAD -- || { echo "工作区有未提交改动，先提交"; exit 1; }

if [[ -z "$notes" ]]; then
  notes="/tmp/$version-notes.md"
  cat > "$notes" <<EOF
MakeMovie $version

## Highlights

- （能力向前：这版能做什么，3-6 条）

## Install

docker compose --profile full up -d --build
# 或使用预构建镜像 ghcr.io/dreamofxm/makemovie/{api,worker,web}:$version
EOF
  "${EDITOR:-vi}" "$notes"
fi

git tag -a "$version" -m "$version"
git push origin "$version"
gh release create "$version" --title "$version" --notes-file "$notes"
echo
echo "完成：标签已推（CI 正在发布镜像），Release 已建。"
echo "  https://github.com/$repo/releases/tag/$version"
echo "查镜像构建：gh run watch \$(gh api 'repos/$repo/actions/runs?event=push' --jq '.workflow_runs[0].id')"
