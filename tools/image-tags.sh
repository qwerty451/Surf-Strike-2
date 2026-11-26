#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

owner=$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')
image="ghcr.io/${owner}/surf-strike-2"
if [[ $REF_TYPE == branch && $REF_NAME == feat/netcode ]]; then
  branch=netcode
else
  slug=$(printf '%s' "$REF_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g')
  digest=$(printf '%s:%s' "$REF_TYPE" "$REF_NAME" | shasum -a 256)
  branch="branch-${slug:0:56}-${digest%% *}"
fi
{
  echo "image=${image}"
  echo "tags<<EOF"
  echo "${image}:${branch}"
  echo "${image}:sha-${SHA:0:7}"
  if [[ $REF_TYPE == branch && $REF_NAME == master ]]; then
    echo "${image}:latest"
  fi
  echo "EOF"
} >> "$GITHUB_OUTPUT"
