#!/usr/bin/env bash
set -euo pipefail

component=${1:?usage: build-docs.sh COMPONENT OUTPUT_DIRECTORY}
output=${2:?usage: build-docs.sh COMPONENT OUTPUT_DIRECTORY}
case "$component" in
    toolkit|mcp|a2a|cli) ;;
    *) printf 'Unknown component: %s\n' "$component" >&2; exit 1 ;;
esac
mkdir -p "$output"
output=$(cd "$output" && pwd)
repo=$(cd "$(dirname "$0")/.." && pwd)
source="$repo/$component"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

cp -R "$source/docs" "$source/scripts" "$scratch/"
cp "$source/mkdocs.yml" "$scratch/"
cp "$source/README.md" "$scratch/docs/index.md"
cp "$source/llms.txt" "$scratch/docs/llms.txt"
if [[ "$component" == toolkit || "$component" == a2a ]]; then
    cp "$source/CHANGELOG.md" "$scratch/docs/changelog.md"
fi
logo="apcore-$component-logo.svg"
mkdir -p "$scratch/docs/assets"
cp "$source/$logo" "$scratch/docs/assets/"
python3 - "$scratch/docs/index.md" "$logo" <<'PY'
import sys
from pathlib import Path

index = Path(sys.argv[1])
logo = sys.argv[2]
text = index.read_text().replace("(./docs/", "(./").replace("(docs/", "(")
text = text.replace(f"./{logo}", f"./assets/{logo}")
changelog = index.with_name("changelog.md")
if changelog.is_file():
    text = text.replace("(CHANGELOG.md)", "(changelog.md)").replace("(./CHANGELOG.md)", "(changelog.md)")
    changelog.write_text(changelog.read_text().replace("(./docs/", "(./").replace("(docs/", "("))
index.write_text(text)
PY

cd "$scratch"
python3 scripts/gen_llms_full.py
mkdocs build --strict --site-dir "$output"
