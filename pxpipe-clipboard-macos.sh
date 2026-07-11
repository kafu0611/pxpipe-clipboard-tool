#!/usr/bin/env bash
set -euo pipefail

# pbpaste/pbcopy pick a text encoding from the locale; in LANG-less environments
# (launchd, cron, some automation shells) non-ASCII clipboard text silently comes
# back empty or lossy. Force UTF-8 for everything this script spawns.
export LC_CTYPE=UTF-8
unset LC_ALL

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RENDERER="$SCRIPT_DIR/pxpipe-render-text.mjs"

image_only=false
copy_factsheet=false
keep_artifacts=false
profile="hybrid"
positional=()
expect_profile=false
for arg in "$@"; do
  if [[ "$expect_profile" == true ]]; then
    profile="$arg"
    expect_profile=false
  elif [[ "$arg" == "--image-only" ]]; then
    image_only=true
  elif [[ "$arg" == "--copy-factsheet" ]]; then
    copy_factsheet=true
  elif [[ "$arg" == "--keep-artifacts" ]]; then
    keep_artifacts=true
  elif [[ "$arg" == "--profile" ]]; then
    expect_profile=true
  else
    positional+=("$arg")
  fi
done
case "$profile" in
  hybrid|balanced|dense|off) ;;
  *)
    echo "--profile requires one of: hybrid, balanced, dense, off." >&2
    exit 1
    ;;
esac
if [[ "$profile" == "off" ]]; then
  echo "Profile 'off': nothing rendered, clipboard left unchanged."
  exit 0
fi
if [[ "$copy_factsheet" == true && "$profile" != "hybrid" ]]; then
  echo "--copy-factsheet requires the hybrid profile (anchor detection is a hybrid feature)." >&2
  exit 1
fi
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

factsheet_path="$OUTPUT_DIR/factsheet.txt"
renderer_args=(--profile "$profile")
if [[ "$profile" == "hybrid" ]]; then
  # Always request the factsheet in hybrid: --copy-factsheet needs the file,
  # and the renderer skips it anyway when no anchor tokens are found.
  renderer_args+=(--emit-factsheet "$factsheet_path")
fi
if [[ "$keep_artifacts" == true ]]; then
  renderer_args+=(--keep-artifacts)
fi
if [[ "$image_only" == true ]]; then
  # Image-only discards the text flavor, so characters the glyph atlas can't
  # render (emoji, mostly) would be silently lost — refuse beyond 1% dropped.
  renderer_args+=(--max-drop-ratio 0.01)
fi

set +e
(
  cd "$SCRIPT_DIR"
  # ${arr[@]+...} guard: bash 3.2 (macOS default) treats expanding an empty
  # array as an unbound variable under `set -u`.
  node "$RENDERER" ${renderer_args[@]+"${renderer_args[@]}"} "$input_file" "$OUTPUT_DIR" >"$stdout_file" 2>"$stderr_file"
)
render_exit=$?
set -e

if [[ "$render_exit" -eq 2 || "$render_exit" -eq 3 ]]; then
  # Renderer declined: not profitable (2) or too much content loss (3).
  # Clipboard was never touched.
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

# The renderer reports on stderr whether it wrote a factsheet this run and
# whether anchor tokens exist. A factsheet.txt from an earlier run must not
# outlive a render of different content.
factsheet_emitted=false
if grep -q '^Factsheet: ' "$stderr_file"; then factsheet_emitted=true; fi
anchors_detected=false
if grep -q 'anchor token(s) detected' "$stderr_file"; then anchors_detected=true; fi
if [[ "$factsheet_emitted" != true && -f "$factsheet_path" ]]; then
  rm -f "$factsheet_path"
fi
if [[ "$keep_artifacts" != true && -f "$OUTPUT_DIR/original.txt" ]]; then
  rm -f "$OUTPUT_DIR/original.txt"
fi

first_page="${pages[0]}"
savings="$(grep -Eo '[0-9.]+% saved' "$stderr_file" | tail -n 1 || true)"

if [[ "$copy_factsheet" == true && "$factsheet_emitted" == true ]]; then
  # Deliberate factsheet step: the clipboard carries the exact tokens as plain
  # text; the rendered pages stay on disk for manual attachment.
  pbcopy < "$factsheet_path"
  echo "Copied the factsheet to the clipboard as text${savings:+; $savings}."
  echo "Rendered page(s) are in $OUTPUT_DIR — attach them separately."
  cat "$stderr_file" >&2 || true
  exit 0
fi
if [[ "$copy_factsheet" == true ]]; then
  echo "No anchor tokens detected; continuing with the normal clipboard copy."
fi

# Put page 1 on the clipboard via the single-item write the single-page case
# uses. macOS has no reliable way to place a multi-file list on the clipboard
# from a short-lived osascript process — NSPasteboard writeObjects: provides
# file-URL data lazily, and nothing persists once osascript exits (verified:
# a fresh reader sees an empty pasteboard) — so for multi-page results we copy
# page 1 and open the folder for the rest rather than silently clearing the
# clipboard.
if [[ "$image_only" == true ]]; then
  # PNG only, no text flavor — for apps whose paste handler prefers text over
  # image whenever both are present on the clipboard.
  osascript "$SCRIPT_DIR/clipboard-write.applescript" "$first_page" ""
  echo "Copied $first_page to the clipboard (image only${savings:+; $savings})."
  if [[ "$anchors_detected" == true ]]; then
    echo "Warning: anchor tokens were detected but the image-only clipboard cannot carry them," >&2
    echo "and exact values are not reliably recoverable from the image." >&2
    echo "Run again with --copy-factsheet to copy them as text." >&2
  fi
else
  # Writes both the PNG and the original text (still sitting in $input_file,
  # byte-exact) as separate flavors on the same clipboard entry, so pasting into
  # a plain-text target still works. Uses argv, not string interpolation, so
  # paths can't break out of the AppleScript source regardless of their contents.
  osascript "$SCRIPT_DIR/clipboard-write.applescript" "$first_page" "$input_file"
  echo "Copied $first_page to the clipboard (with original text as a fallback flavor${savings:+; $savings})."
fi
echo "Rendered ${#pages[@]} page(s) in $OUTPUT_DIR."

if [[ "${#pages[@]}" -gt 1 ]]; then
  message="Rendered ${#pages[@]} images. Page 1 is on the clipboard; opening the folder for the remaining pages."
  if [[ "$factsheet_emitted" == true ]]; then
    message="$message factsheet.txt in the folder holds the exact tokens — attach it with the images."
  fi
  echo "$message"
  osascript -e "display notification \"$message\" with title \"pxpipe images ready\"" >/dev/null 2>&1 || true
  open "$OUTPUT_DIR"
fi

cat "$stderr_file" >&2 || true
