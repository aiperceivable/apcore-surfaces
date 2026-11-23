#!/usr/bin/env bash
set -euo pipefail

output=${1:?usage: build-site.sh OUTPUT_DIRECTORY}
repo=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$output"
output=$(cd "$output" && pwd)

for component in toolkit mcp a2a cli; do
    "$repo/scripts/build-docs.sh" "$component" "$output/$component"
done

cat > "$output/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>APCore Surfaces documentation</title>
</head>
<body>
  <main>
    <h1>APCore Surfaces documentation</h1>
    <ul>
      <li><a href="toolkit/">Toolkit</a></li>
      <li><a href="mcp/">MCP</a></li>
      <li><a href="a2a/">A2A</a></li>
      <li><a href="cli/">CLI</a></li>
    </ul>
    <p><a href="https://apcore.aiperceivable.com/">APCore runtime and specification</a></p>
  </main>
</body>
</html>
HTML
