#!/usr/bin/env bash
set -euo pipefail

# Extract one version's changelog section (without the heading) into a file.
# Usage: extract-changelog.sh <tag> <output-file> [changelog-file]

tag="${1:?usage: extract-changelog.sh <tag> <output-file>}"
out="${2:?usage: extract-changelog.sh <tag> <output-file>}"
changelog="${3:-CHANGELOG.md}"
section="[${tag#v}]"

awk -v section="${section}" '
  index($0, "## [" section "] - ") == 1 { in_section = 1; next }
  /^## \[/ { if (in_section) exit }
  in_section { print }
' "${changelog}" > "${out}"

if [ ! -s "${out}" ]; then
  echo "changelog section for ${tag} not found in ${changelog}" >&2
  exit 1
fi
