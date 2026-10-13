#!/bin/sh
# Install the client app gate as this repo's pre-push hook (shared by every worktree of the repo).
set -e
hooks="$(git rev-parse --git-common-dir)/hooks"
cp "$(dirname "$0")/pre-push" "$hooks/pre-push"
chmod +x "$hooks/pre-push"
echo "installed $hooks/pre-push"
