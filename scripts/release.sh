#!/usr/bin/env bash
# MakeMovie 一键发版：打标签 → 推标签（CI 自动构建发布三镜像到 ghcr，并发布 npm 包）→ 建 Release。
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

# package.json 是版本号的单一真相源：npm 上发布的版本必须等于 tag，否则
# npx makemovie@latest 拿到的会是一份与 Release 对不上的手册。
pkg_version="v$(node -p "require('./package.json').version")"
[[ "$version" == "$pkg_version" ]] || {
  echo "tag $version 与 package.json 的 version（$pkg_version）不一致"
  echo "先把 package.json 的 version 改成 ${version#v}，再发版。"
  exit 1
}

if [[ -z "$notes" ]]; then
  notes="/tmp/$version-notes.md"
  cat > "$notes" <<EOF
MakeMovie $version

## Highlights

- （能力向前：这版能做什么，3-6 条）

## Install

npx -y makemovie@latest          # 读整份手册，无需 clone

# 两条 wget 一条 up（附件就是本仓库的 docker-compose.yml / .env.example）：
mkdir makemovie && cd makemovie
wget https://github.com/DreamOfXM/makemovie/releases/download/$version/docker-compose.yml
wget https://github.com/DreamOfXM/makemovie/releases/download/$version/example.env -O .env
VERSION=${version#v} docker compose --profile full up -d
EOF
  "${EDITOR:-vi}" "$notes"
fi

git tag -a "$version" -m "$version"
git push origin "$version"
gh release create "$version" --title "$version" --notes-file "$notes" \
  docker-compose.yml ".env.example#example.env"
echo
echo "完成：标签已推（CI 正在发布镜像与 npm 包），Release 已建。"
echo "  https://github.com/$repo/releases/tag/$version"
echo "  https://www.npmjs.com/package/makemovie"
echo "查镜像构建：gh run watch \$(gh api 'repos/$repo/actions/runs?event=push' --jq '.workflow_runs[0].id')"
