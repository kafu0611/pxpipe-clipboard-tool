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
  powershell -ExecutionPolicy Bypass -File "C:\path\to\pxpipe-clipboard-tool\pxpipe-clipboard.ps1" @args
}
```

`@args` forwards whatever you pass to `pxclip` (e.g. `pxclip -ImageOnly`) on to the script —
without it, PowerShell functions silently drop any arguments the caller supplies.

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

- **Leading/trailing blank lines are trimmed.** The renderer sizes each page to
  its actual line count, so blank lines at the very start or end of the
  clipboard content aren't free — they occupy real, billed pixel rows just
  like any other line. The tool trims the text (and only the copy it images
  and tokenizes) before rendering, so an accidental trailing blank line or two
  from your copy source doesn't cost extra image tokens or push content onto
  an extra page. This does not touch the clipboard's text flavor, which still
  carries exactly what you copied.
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
- Multi-page output:
  - **macOS** copies **page 1** to the clipboard (with the original text as a
    fallback flavor, as in the single-page case) and opens the output folder so
    you can drag in the remaining pages, with a notification when possible.
    macOS has no reliable way to place a multi-file list on the clipboard from a
    short-lived `osascript` process, so it does not try.
  - **Windows** copies **all pages to the clipboard as a file list**, so paste
    targets that accept file drops (Explorer, Slack, …) receive every page at
    once; the original text rides along as a separate format unless `-ImageOnly`.
  - On both platforms the PNGs also remain in the output folder.
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

# Also write a machine-readable decision report
node ./pxpipe-render-text.mjs --report-json ./report.json input.txt ./pxpipe-images
```

**Renderer output contract:** stdout carries the written PNG paths, one per
line, and nothing else — scripts may rely on that. Everything else (warnings,
savings) goes to stderr; machine consumers should use `--report-json PATH`,
which records the decision, mode, token estimates, drop ratio, and whether the
cost constants came from the installed package (`costModelSource: "live"`) or
the pinned fallbacks (`"fallback"`).

Renderer exit codes: `0` success, `1` usage/input error, `2` declined (not
profitable), `3` declined (too many unrenderable characters for the requested
`--max-drop-ratio`).

## Using with the pxpipe proxy

This tool covers what upstream's local proxy can't reach: web and desktop chat
interfaces that don't route through a system proxy. For CLI clients, upstream
pxpipe itself is the right tool — see
[teamchong/pxpipe](https://github.com/teamchong/pxpipe) for running its local
proxy (e.g. `ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude` for Claude
Code). This project deliberately does not manage, launch, or diagnose that
proxy; it only shares the published `pxpipe-proxy` package as a dependency.

## Tracking upstream releases

The dependency is pinned to an exact published version (`pxpipe-proxy@0.8.0`).
To move the pin:

1. Bump the version in `package.json` on a branch and `npm install`.
2. Run `npm test` — `test/adapter.test.mjs` asserts the installed package still
   ships the layout this tool depends on (public `renderTextToImages`, readable
   cost constants, bundled tokenizer). A `costModelSource: "fallback"` failure
   there means the estimates would silently drift; fix the adapter first.
3. Prefer newly public upstream APIs over local code when they appear — e.g.
   drop the deep import in `lib/pxpipe-adapter.mjs` if the cost constants ever
   gain a public export. Never depend on unreleased upstream `main`.

## Credits

This tool builds on [teamchong/pxpipe](https://github.com/teamchong/pxpipe)
(MIT licensed), which provides the underlying text-to-image rendering via its
`pxpipe-proxy` npm package (declared as a dependency in `package.json`). The
core design — rendering dense text as PNG pages to reduce vision-token cost
relative to plain text — originates there. All access to the installed
package's files is centralized in `lib/pxpipe-adapter.mjs`, the single point of
upstream coupling: the cost-model constants used by the profitability gate
(`REPORT_CHARS_PER_TOKEN`, `ANTHROPIC_PIXELS_PER_TOKEN`,
`IMAGE_COST_SAFETY_MARGIN`) are imported at runtime from the installed
package's `dist/core/transform.js` — they are module-level exports that just
aren't on the package's public exports map — with pinned literals as a
fallback when that deep import fails (the renderer warns and reports
`costModelSource: "fallback"` when that happens); the per-page token formula is
adapted from `pxpipe-proxy`'s `export.js`. See the citation comments in each
file for exact references.
