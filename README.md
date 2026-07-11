# pxpipe clipboard tool

Render clipboard text into pxpipe PNG pages and copy the result back to the
clipboard, only when doing so actually saves tokens — if imaging wouldn't
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

Default output folder: `C:\Users\<you>\pxpipe-images`

| Flag | Effect |
| --- | --- |
| `-OutputDir <path>` | positional; where to write PNGs |
| `-Renderer <path>` | positional; path to `pxpipe-render-text.mjs` (defaults to the copy next to this script) |
| `-ImageOnly` | copy only the PNG — no text fallback (see [Behavior](#behavior)) |

Unrecognized flags now fail with a clear error instead of being silently
ignored (fixed in v1.3.2) — if you get "A parameter cannot be found that
matches parameter name '...'", check the spelling against the table above.

For a shortcut, add this to your PowerShell profile:

```powershell
function pxclip {
  powershell -ExecutionPolicy Bypass -File "C:\path\to\pxpipe-clipboard-tool\pxpipe-clipboard.ps1" @args
}
```

`@args` forwards whatever you pass to `pxclip` (e.g. `pxclip -ImageOnly`) on to
the script — **without it, PowerShell functions silently drop any arguments
the caller supplies**, which looks identical to the flag doing nothing.

Your profile is the file at `$PROFILE` — it may not exist yet. Create or edit
it with:

```powershell
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force }
notepad $PROFILE
```

Then restart PowerShell (or run `. $PROFILE`) to load it.

## macOS

Make the launcher executable once:

```sh
chmod +x ./pxpipe-clipboard-macos.sh
```

Copy the text you want to render, then run:

```sh
./pxpipe-clipboard-macos.sh
```

Default output folder: `~/pxpipe-images`

| Flag | Effect |
| --- | --- |
| `[output-dir]` | positional; where to write PNGs |
| `--image-only` | copy only the PNG — no text fallback (see [Behavior](#behavior)) |

Unrecognized flags (anything starting with `-` that isn't `--image-only`)
fail with `Unknown option: ...` instead of silently becoming the output
directory name.

For a shortcut, add this to `~/.zshrc`:

```sh
alias pxclip="/path/to/pxpipe-clipboard-tool/pxpipe-clipboard-macos.sh"
```

Then restart your terminal or run `source ~/.zshrc`. Unlike PowerShell
functions, shell aliases forward trailing arguments automatically — no `@args`
equivalent needed.

## Behavior

- **Profitability gate.** Before writing anything, the tool compares text
  tokens vs. image tokens for your clipboard content. Text tokens are counted
  with a real tokenizer (`gpt-tokenizer`'s o200k encoding, already installed
  as pxpipe-proxy's own dependency — conservative relative to Claude's
  tokenizer), falling back to the chars/3.7 heuristic if the tokenizer can't
  be loaded. If imaging wouldn't cost fewer tokens than plain text, it prints
  why and leaves your clipboard completely unchanged (exit code 2) — nothing
  is written, nothing is copied.
- **Leading/trailing blank lines are trimmed** before that comparison and
  before rendering. The renderer sizes each page to its actual line count, so
  blank lines at the very start or end of the clipboard content aren't free —
  they'd occupy real, billed pixel rows like any other line. This doesn't
  touch the clipboard's text flavor, which still carries exactly what you
  copied.
- **Adaptive mode with a legibility bias.** When it is profitable, the tool
  renders both a readable (legible) and a dense/reflow candidate and keeps
  readable unless dense saves at least 15% over it (or readable isn't itself
  profitable). This avoids a real failure mode of the readable renderer:
  content that mixes one long unwrapped line with many short lines can
  otherwise cost *more* tokens than plain text, because canvas width is set
  from the widest line and every other line gets padded out to it — dense mode
  packs around that.
- **Unrenderable characters are surfaced, and gated in image-only mode.**
  Characters missing from the glyph atlas (emoji are the usual case) render as
  blank cells. The tool always warns when any are dropped. In image-only mode
  (`-ImageOnly` / `--image-only`) — where no text flavor survives to preserve
  the original — the wrapper additionally refuses outright (exit code 3,
  clipboard untouched) if more than 1% of characters would be lost.
- **Text survives by default.** The clipboard write puts both the PNG and your
  original text on the clipboard as separate flavors of the same entry, so
  pasting into a plain-text target (terminal, code editor, form field) still
  works even after the tool has run.
- **Image-only for apps that need it.** Some paste targets read the
  clipboard's *text* flavor whenever one is present and never look for the
  image, even if you meant to attach the image — for example, Claude Code's
  desktop/web client's plain paste behaves this way when both flavors are on
  the clipboard. Pass `-ImageOnly` (Windows) / `--image-only` (macOS) to write
  only the PNG, forcing those apps to pick it up. The profitability gate still
  applies exactly as in the default mode: if imaging wouldn't save tokens, the
  tool still declines and leaves your original clipboard text untouched —
  image-only never forces a losing trade, it only changes what gets written
  when the trade is already a win.
- **Single-page output:** copies `page-01.png` to the clipboard.
- **Multi-page output** differs by platform:
  - **Windows** copies **all pages to the clipboard as a file list**, so paste
    targets that accept file drops (Explorer, Slack, …) receive every page at
    once; the original text rides along as a separate format unless
    `-ImageOnly`.
  - **macOS** copies **only page 1** to the clipboard (with the original text
    as a fallback flavor, as in the single-page case) and **opens the output
    folder** so you can drag in the remaining pages, with a notification when
    possible. macOS has no reliable way to place a multi-file list on the
    clipboard from a short-lived `osascript` process, so it does not try.
  - On both platforms every page also remains as a file in the output folder.
- The final "Copied …" line includes the estimated token savings.
- The tool intentionally does not merge pages. Very large merged images can
  cost more image tokens and can reduce legibility.

## CLI reference (`pxpipe-render-text.mjs`)

The wrappers call this for you; use it directly for scripting or to inspect a
file without touching the clipboard.

```sh
node ./pxpipe-render-text.mjs [options] input.txt out-dir
node ./pxpipe-render-text.mjs [options] --stdin out-dir   # read from stdin instead of a file
```

| Flag | Effect |
| --- | --- |
| `--dense` | render only the dense/reflow candidate (still gated unless `--force`) |
| `--force` | write output even when gated (unprofitable or lossy) |
| `--dry-run` | report the estimate and decision without writing any files |
| `--max-drop-ratio R` | decline (exit 3) when more than fraction `R` of the characters have no glyph in the atlas |
| `--report-json PATH` | also write the decision and estimates as JSON to `PATH` |

Examples:

```sh
# Dense-only candidate (still gated — declines if not profitable)
node ./pxpipe-render-text.mjs --dense input.txt ./pxpipe-images

# Bypass the gates entirely and write unconditionally
node ./pxpipe-render-text.mjs --force input.txt ./pxpipe-images

# Report the decision and estimated savings without writing anything
node ./pxpipe-render-text.mjs --dry-run input.txt ./pxpipe-images

# Also write a machine-readable decision report
node ./pxpipe-render-text.mjs --report-json ./report.json input.txt ./pxpipe-images

# Pipe text in instead of using a file
echo "some text" | node ./pxpipe-render-text.mjs --stdin ./pxpipe-images
```

**Output contract:** stdout carries the written PNG paths, one per line, and
nothing else — scripts may rely on that. Everything else (warnings, savings)
goes to stderr; machine consumers should use `--report-json PATH`, which
records the decision, mode, token estimates, drop ratio, and whether the cost
constants came from the installed package (`costModelSource: "live"`) or the
pinned fallbacks (`"fallback"`).

**Exit codes:** `0` success, `1` usage/input error, `2` declined (not
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
