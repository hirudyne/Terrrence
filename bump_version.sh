#!/bin/sh
# Usage: ./bump_version.sh [major|minor|patch]
# Defaults to patch.

LEVEL=${1:-patch}
CURRENT=$(cat /workspace/VERSION)
MAJOR=$(echo $CURRENT | cut -d. -f1)
MINOR=$(echo $CURRENT | cut -d. -f2)
PATCH=$(echo $CURRENT | cut -d. -f3)

case $LEVEL in
  major) MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR+1)); PATCH=0 ;;
  patch) PATCH=$((PATCH+1)) ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"
echo $NEW > /workspace/VERSION
echo $NEW
