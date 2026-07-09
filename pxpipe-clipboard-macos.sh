#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RENDERER="$SCRIPT_DIR/pxpipe-render-text.mjs"

image_only=false
positional=()
for arg in "$@"; do
  if [[ "$arg" == "--image-only" ]]; then
    image_only=true
  else
    positional+=("$arg")
  fi
done
OUTPUT_DIR="${positional[0]:-"$HOME/pxpipe-images"}"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required. Install Node.js first." >&2
  exit 1
fi

if ! command -v pbpaste >/dev/null 2>&1; then
  echo "pbpaste is required; this script is intended for macOS." >&2
  exit 1
fi

input_file="$(mktemp)"
stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
trap 'rm -f "$input_file" "$stdout_file" "$stderr_file"' EXIT

# Byte-exact capture: pbpaste directly to file, not via "$(...)" (which strips
# trailing newlines) — this file also stands in for the original clipboard text
# later, so what's on the clipboard today should be exactly what's here.
pbpaste > "$input_file"

if ! grep -q '[^[:space:]]' "$input_file"; then
  echo "Clipboard does not contain text to render." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

set +e
(
  cd "$SCRIPT_DIR"
  node "$RENDERER" "$input_file" "$OUTPUT_DIR" >"$stdout_file" 2>"$stderr_file"
)
render_exit=$?
set -e

if [[ "$render_exit" -eq 2 ]]; then
  # Renderer declined: imaging wouldn't save tokens. Clipboard was never touched.
  cat "$stderr_file" >&2 || true
  exit 0
elif [[ "$render_exit" -ne 0 ]]; then
  echo "Renderer failed (exit $render_exit)." >&2
  cat "$stderr_file" >&2 || true
  exit 1
fi

pages=()
while IFS= read -r line; do
  pages+=("$line")
done < <(grep -E '\.png$' "$stdout_file" || true)
if [[ "${#pages[@]}" -eq 0 ]]; then
  echo "Renderer did not produce any PNG files." >&2
  cat "$stderr_file" >&2 || true
  exit 1
fi

# Renderer overwrote page-01..N in place. Only now, having confirmed a fresh
# successful render exists, remove stale higher-numbered pages left behind by
# an earlier run that produced more pages than this one.
find "$OUTPUT_DIR" -maxdepth 1 -type f -name 'page-*.png' | while read -r f; do
  idx=$(basename "$f" | sed -E 's/page-0*([0-9]+)\.png/\1/')
  if [[ "$idx" -gt "${#pages[@]}" ]]; then rm -f "$f"; fi
done
find "$OUTPUT_DIR" -maxdepth 1 -type f -name 'combined.png' -delete

first_page="${pages[0]}"

if [[ "$image_only" == true ]]; then
  # PNG only, no text flavor — for apps whose paste handler prefers text over
  # image whenever both are present on the clipboard.
  osascript "$SCRIPT_DIR/clipboard-write.applescript" "$first_page" ""
  echo "Copied $first_page to the clipboard (image only)."
else
  # Writes both the PNG and the original text (still sitting in $input_file,
  # byte-exact) as separate flavors on the same clipboard entry, so pasting into
  # a plain-text target still works. Uses argv, not string interpolation, so
  # paths can't break out of the AppleScript source regardless of their contents.
  osascript "$SCRIPT_DIR/clipboard-write.applescript" "$first_page" "$input_file"
  echo "Copied $first_page to the clipboard (with original text as a fallback flavor)."
fi
echo "Rendered ${#pages[@]} page(s) in $OUTPUT_DIR."

if [[ "${#pages[@]}" -gt 1 ]]; then
  message="Rendered ${#pages[@]} images. Page 1 is on the clipboard; opening the folder for the remaining pages."
  echo "$message"
  osascript -e "display notification \"$message\" with title \"pxpipe images ready\"" >/dev/null 2>&1 || true
  open "$OUTPUT_DIR"
fi

cat "$stderr_file" >&2 || true
