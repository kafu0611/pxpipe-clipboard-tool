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

- **Profitability gate.** Before writing anything, the tool estimates text tokens
  vs. image tokens for your clipboard content. If imaging wouldn't cost fewer
  tokens than plain text, it prints why and leaves your clipboard completely
  unchanged (exit code 2) — nothing is written, nothing is copied.
- **Adaptive mode.** When it is profitable, the tool renders both a readable
  (default, legible) and a dense/reflow candidate and keeps whichever actually
  costs fewer tokens, favoring readable on a tie. This avoids a real failure
  mode of the readable renderer: content that mixes one long unwrapped line
  with many short lines can otherwise cost *more* tokens than plain text,
  because canvas width is set from the widest line and every other line gets
  padded out to it — dense mode packs around that.
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
- Multi-page output: copies `page-01.png`, shows a notification when possible,
  and opens the output folder so you can attach the remaining pages.
- The tool intentionally does not merge pages. Very large merged images can cost
  more image tokens and can reduce legibility.

Manual render, forcing a specific mode:

```sh
# Dense-only candidate (still gated — declines if not profitable)
node ./pxpipe-render-text.mjs --dense input.txt ./pxpipe-images

# Bypass the profitability gate entirely and write unconditionally
node ./pxpipe-render-text.mjs --force input.txt ./pxpipe-images
```

## Credits

This tool builds on [teamchong/pxpipe](https://github.com/teamchong/pxpipe)
(MIT licensed), which provides the underlying text-to-image rendering via its
`pxpipe-proxy` npm package (declared as a dependency in `package.json`). The
core design — rendering dense text as PNG pages to reduce vision-token cost
relative to plain text — originates there. A few internal, unexported cost-model
constants used by the profitability gate (`REPORT_CHARS_PER_TOKEN`,
`ANTHROPIC_PIXELS_PER_TOKEN`, the per-page token formula) are also adapted
directly from `pxpipe-proxy`'s source, since no public API exposes them; see
the citation comments in `pxpipe-render-text.mjs` for exact file:line
references.
