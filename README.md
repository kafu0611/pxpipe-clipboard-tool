# pxpipe clipboard tool

Render clipboard text into pxpipe PNG pages, copy `page-01.png` to the clipboard
alongside the original text, and open the output folder when multiple pages are
produced. Only renders when it would actually save tokens — if imaging wouldn't
help, the tool leaves your clipboard untouched.

## Install

Install dependencies once inside this folder:

```sh
npm install
```

Node.js 18 or newer is required.

## Windows

Copy the text you want to render, then run:

```powershell
powershell -ExecutionPolicy Bypass -File ".\pxpipe-clipboard.ps1"
```

Default output folder:

```text
C:\Users\<you>\pxpipe-images
```

For a shortcut, add this to your PowerShell profile:

```powershell
function pxclip {
  powershell -ExecutionPolicy Bypass -File "C:\path\to\pxpipe-clipboard-tool\pxpipe-clipboard.ps1"
}
```

## macOS

Make the launcher executable once:

```sh
chmod +x ./pxpipe-clipboard-macos.sh
```

Copy the text you want to render, then run:

```sh
./pxpipe-clipboard-macos.sh
```

Default output folder:

```text
~/pxpipe-images
```

For a shortcut, add this to `~/.zshrc`:

```sh
alias pxclip="/path/to/pxpipe-clipboard-tool/pxpipe-clipboard-macos.sh"
```

Then restart your terminal or run `source ~/.zshrc`.

## Behavior

- **Profitability gate.** Before writing anything, the tool compares text tokens
  vs. image tokens for your clipboard content. Text tokens are counted with a
  real tokenizer (`gpt-tokenizer`'s o200k encoding, already installed as
  pxpipe-proxy's own dependency — conservative relative to Claude's tokenizer),
  falling back to the chars/3.7 heuristic if the tokenizer can't be loaded. If
  imaging wouldn't cost fewer tokens than plain text, it prints why and leaves
  your clipboard completely unchanged (exit code 2) — nothing is written,
  nothing is copied.
- **Adaptive mode with a legibility bias.** When it is profitable, the tool
  renders both a readable (legible) and a dense/reflow candidate and keeps
  readable unless dense saves at least 15% over it (or readable isn't itself
  profitable). This avoids a real failure mode of the readable renderer:
  content that mixes one long unwrapped line with many short lines can
  otherwise cost *more* tokens than plain text, because canvas width is set
  from the widest line and every other line gets padded out to it — dense mode
  packs around that.
- **Unrenderable characters are surfaced, and gated in `--image-only` mode.**
  Characters missing from the glyph atlas (emoji are the usual case) render as
  blank cells. The tool always warns when any are dropped. In `--image-only`
  mode — where no text flavor survives to preserve the original — it refuses
  outright (exit code 3, clipboard untouched) if more than 1% of characters
  would be lost.
- **Text survives, by default.** The clipboard write puts both the PNG and your
  original text on the clipboard as separate flavors of the same entry, so
  pasting into a plain-text target (terminal, code editor, form field) still
  works even after the tool has run.
- **`--image-only` for apps that need it.** Some paste targets read the
  clipboard's *text* flavor whenever one is present and never look for the
  image, even if you meant to attach the image — for example, Claude Code's
  desktop/web client's plain paste behaves this way when both flavors are on
  the clipboard. Pass `--image-only` (macOS: `./pxpipe-clipboard-macos.sh
  --image-only`; Windows: `.\pxpipe-clipboard.ps1 -ImageOnly`) to write only
  the PNG, forcing those apps to pick it up. The profitability gate still
  applies in this mode exactly as in the default mode: if imaging wouldn't
  save tokens, the tool still declines and leaves your original clipboard text
  untouched — `--image-only` never forces a losing trade, it only changes what
  gets written when the trade is already a win.
- Single-page output: copies `page-01.png` to the clipboard.
- Multi-page output: copies **all pages to the clipboard as a file list**, so
  paste targets that accept file drops (Claude Code, Finder/Explorer, Slack, …)
  receive every page at once, and shows a notification when possible. Note that
  on macOS the file list carries no plain-text flavor, so a multi-page result
  pasted into a text-only target yields file paths, not the original text (on
  Windows the original text rides along unless `-ImageOnly`). The PNGs also
  remain in the output folder.
- The final "Copied …" line includes the estimated token savings.
- The tool intentionally does not merge pages. Very large merged images can cost
  more image tokens and can reduce legibility.

Manual render, forcing a specific mode:

```sh
# Dense-only candidate (still gated — declines if not profitable)
node ./pxpipe-render-text.mjs --dense input.txt ./pxpipe-images

# Bypass the gates entirely and write unconditionally
node ./pxpipe-render-text.mjs --force input.txt ./pxpipe-images

# Report the decision and estimated savings without writing anything
node ./pxpipe-render-text.mjs --dry-run input.txt ./pxpipe-images
```

Renderer exit codes: `0` success, `1` usage/input error, `2` declined (not
profitable), `3` declined (too many unrenderable characters for the requested
`--max-drop-ratio`).

## Credits

This tool builds on [teamchong/pxpipe](https://github.com/teamchong/pxpipe)
(MIT licensed), which provides the underlying text-to-image rendering via its
`pxpipe-proxy` npm package (declared as a dependency in `package.json`). The
core design — rendering dense text as PNG pages to reduce vision-token cost
relative to plain text — originates there. The cost-model constants used by the
profitability gate (`REPORT_CHARS_PER_TOKEN`, `ANTHROPIC_PIXELS_PER_TOKEN`,
`IMAGE_COST_SAFETY_MARGIN`) are imported at runtime from the installed
package's `dist/core/transform.js` — they are module-level exports that just
aren't on the package's public exports map — with pinned literals as a
fallback when that deep import fails; the per-page token formula is adapted
from `pxpipe-proxy`'s `export.js`. See the citation comments in
`pxpipe-render-text.mjs` for exact file:line references.
