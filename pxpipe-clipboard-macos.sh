#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${1:-"$HOME/pxpipe-images"}"
RENDERER="$SCRIPT_DIR/pxpipe-render-text.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required. Install Node.js first." >&2
  exit 1
fi

if ! command -v pbpaste >/dev/null 2>&1; then
  echo "pbpaste is required; this script is intended for macOS." >&2
  exit 1
fi

text="$(pbpaste)"
if [[ -z "${text//[[:space:]]/}" ]]; then
  echo "Clipboard does not contain text to render." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
find "$OUTPUT_DIR" -maxdepth 1 -type f -name 'page-*.png' -delete

input_file="$(mktemp)"
stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
trap 'rm -f "$input_file" "$stdout_file" "$stderr_file"' EXIT

printf '%s' "$text" > "$input_file"

(
  cd "$SCRIPT_DIR"
  node "$RENDERER" "$input_file" "$OUTPUT_DIR" >"$stdout_file" 2>"$stderr_file"
)

pages=()
while IFS= read -r line; do
  pages+=("$line")
done < <(grep -E '\.png$' "$stdout_file" || true)
if [[ "${#pages[@]}" -eq 0 ]]; then
  echo "Renderer did not produce any PNG files." >&2
  cat "$stderr_file" >&2 || true
  exit 1
fi

first_page="${pages[0]}"

osascript \
  -e "set pngFile to POSIX file \"$first_page\"" \
  -e "set the clipboard to (read pngFile as «class PNGf»)"

echo "Copied $first_page to the clipboard."
echo "Rendered ${#pages[@]} page(s) in $OUTPUT_DIR."

if [[ "${#pages[@]}" -gt 1 ]]; then
  message="Rendered ${#pages[@]} images. Page 1 is on the clipboard; opening the folder for the remaining pages."
  echo "$message"
  osascript -e "display notification \"$message\" with title \"pxpipe images ready\"" >/dev/null 2>&1 || true
  open "$OUTPUT_DIR"
fi

cat "$stderr_file" >&2 || true
