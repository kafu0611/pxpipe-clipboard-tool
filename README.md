# pxpipe clipboard tool

Render clipboard text into pxpipe PNG pages, copy `page-01.png` to the clipboard,
and open the output folder when multiple pages are produced.

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

- Single-page output: copies `page-01.png` to the clipboard.
- Multi-page output: copies `page-01.png`, shows a notification when possible,
  and opens the output folder so you can attach the remaining pages.
- The tool intentionally does not merge pages. Very large merged images can cost
  more image tokens and can reduce legibility.
