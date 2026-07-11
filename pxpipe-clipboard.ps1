param(
    [string]$OutputDir = "$env:USERPROFILE\pxpipe-images",
    [string]$Renderer = "$PSScriptRoot\pxpipe-render-text.mjs",
    # hybrid: adaptive render plus anchor-token detection (default).
    # balanced: adaptive render only. dense: explicitly lossy dense render.
    # off: leave the clipboard untouched and do nothing.
    [ValidateSet("hybrid", "balanced", "dense", "off")]
    [string]$Profile = "hybrid",
    # PNG only, no text flavor — for apps whose paste handler prefers text over
    # image whenever both are present on the clipboard.
    [switch]$ImageOnly,
    # Put the factsheet (detected anchor tokens) on the clipboard as plain text
    # instead of the image; the rendered pages stay on disk in $OutputDir.
    # An explicit second step by design: one clipboard entry cannot guarantee
    # a paste target consumes both the image and the factsheet.
    [switch]$CopyFactsheet,
    # Also persist the original clipboard text as original.txt in $OutputDir.
    # Off by default so secrets and private content never land on disk silently.
    [switch]$KeepArtifacts
)

$ErrorActionPreference = "Stop"

if ($Profile -eq "off") {
    Write-Host "Profile 'off': nothing rendered, clipboard left unchanged."
    return
}
if ($CopyFactsheet -and $Profile -ne "hybrid") {
    throw "-CopyFactsheet requires the hybrid profile (anchor detection is a hybrid feature)."
}

# Windows argv quoting rule: only quotes, and backslash runs immediately before
# a quote (or before the closing quote we add), need escaping. Doubling every
# backslash happens to survive path normalization but is the wrong rule.
function Quote-ProcessArgument {
    param([string]$Value)
    '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node is required. Install Node.js first."
}

$text = Get-Clipboard -Raw
if ([string]::IsNullOrWhiteSpace($text)) {
    throw "Clipboard does not contain text to render."
}

if (-not (Test-Path -LiteralPath $Renderer)) {
    throw "Renderer not found: $Renderer"
}

if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$stdout = [System.IO.Path]::GetTempFileName()
$stderr = [System.IO.Path]::GetTempFileName()
$inputFile = [System.IO.Path]::GetTempFileName()

try {
    # BOM-less UTF-8 with nothing appended: Set-Content -Encoding UTF8 on
    # Windows PowerShell 5.1 writes a BOM (which Node's utf8 read keeps, so the
    # renderer would see a stray U+FEFF) and adds a trailing newline.
    # CRLF is normalized to LF for the renderer only: the glyph atlas has no \r,
    # so every Windows line ending would otherwise count as a dropped character
    # and short-lined text would trip -ImageOnly's 1% drop gate. The clipboard
    # text flavor below still carries $text exactly as it came in.
    [System.IO.File]::WriteAllText($inputFile, ($text -replace "`r`n", "`n"))

    $factsheetPath = Join-Path $OutputDir "factsheet.txt"
    $rendererArgs = @("--profile", $Profile)
    if ($Profile -eq "hybrid") {
        # Always request the factsheet in hybrid: multi-page drop lists and
        # -CopyFactsheet both need the file, and the renderer skips it anyway
        # when no anchor tokens are found.
        $rendererArgs += @("--emit-factsheet", $factsheetPath)
    }
    if ($KeepArtifacts) {
        $rendererArgs += @("--keep-artifacts")
    }
    if ($ImageOnly) {
        # Image-only discards the text flavor, so characters the glyph atlas
        # can't render (emoji, mostly) would be silently lost — refuse beyond
        # 1% dropped (renderer exit code 3).
        $rendererArgs += @("--max-drop-ratio", "0.01")
    }

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "node"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.Arguments = @(
        @($Renderer) + $rendererArgs + @($inputFile, $OutputDir) |
            ForEach-Object { Quote-ProcessArgument $_ }
    ) -join " "

    $process = [System.Diagnostics.Process]::Start($psi)
    $outText = $process.StandardOutput.ReadToEnd()
    $errText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    Set-Content -LiteralPath $stdout -Value $outText -Encoding UTF8
    Set-Content -LiteralPath $stderr -Value $errText -Encoding UTF8
    $out = $outText -split "\r?\n" | Where-Object { $_ }
    $err = $errText -split "\r?\n" | Where-Object { $_ }

    if ($process.ExitCode -eq 2 -or $process.ExitCode -eq 3) {
        # Renderer declined: not profitable (2) or too much content loss (3).
        # Clipboard was never touched.
        Write-Host ($err -join "`n")
        return
    }
    elseif ($process.ExitCode -ne 0) {
        throw "Renderer failed with exit code $($process.ExitCode). $($err -join ' ')"
    }

    $pages = @($out | Where-Object { $_ -match '\.png$' })
    if ($pages.Count -eq 0) {
        throw "Renderer did not produce any PNG files. $($err -join ' ')"
    }

    # Renderer overwrote page-01..N in place. Only now, having confirmed a fresh
    # successful render exists, remove stale higher-numbered pages left behind by
    # an earlier run that produced more pages than this one.
    Get-ChildItem -LiteralPath $OutputDir -Filter "page-*.png" -File | ForEach-Object {
        if ($_.BaseName -match 'page-0*(\d+)$') {
            $idx = [int]$Matches[1]
            if ($idx -gt $pages.Count) { Remove-Item -LiteralPath $_.FullName -Force }
        }
    }
    Get-ChildItem -LiteralPath $OutputDir -Filter "combined.png" -File | Remove-Item -Force

    # The renderer reports on stderr whether it wrote a factsheet this run and
    # whether anchor tokens exist. A factsheet.txt from an earlier run must not
    # outlive a render of different content.
    $factsheetEmitted = [bool]($err | Where-Object { $_ -match '^Factsheet: ' })
    $anchorsDetected = [bool]($err | Where-Object { $_ -match 'anchor token\(s\) detected' })
    if (-not $factsheetEmitted -and (Test-Path -LiteralPath $factsheetPath)) {
        Remove-Item -LiteralPath $factsheetPath -Force
    }
    if (-not $KeepArtifacts) {
        $originalPath = Join-Path $OutputDir "original.txt"
        if (Test-Path -LiteralPath $originalPath) { Remove-Item -LiteralPath $originalPath -Force }
    }

    $savings = ""
    $savedMatch = $err | Select-String -Pattern '[\d.]+% saved' | Select-Object -Last 1
    if ($savedMatch) { $savings = "; " + $savedMatch.Matches[0].Value }

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    if ($CopyFactsheet -and $factsheetEmitted) {
        # Deliberate factsheet step: the clipboard carries the exact tokens as
        # plain text; the rendered pages stay on disk for manual attachment.
        $factsheetText = [System.IO.File]::ReadAllText($factsheetPath)
        [System.Windows.Forms.Clipboard]::SetText($factsheetText)
        Write-Host "Copied the factsheet to the clipboard as text$savings."
        Write-Host "Rendered page(s) are in $OutputDir - attach them separately."
        Write-Host ($err -join "`n")
        return
    }
    if ($CopyFactsheet) {
        Write-Host "No anchor tokens detected; continuing with the normal clipboard copy."
    }

    if ($pages.Count -gt 1) {
        # All pages go on the clipboard as a file drop list, so paste targets
        # that accept file drops receive every page at once. The original text
        # rides along as a separate format unless -ImageOnly.
        $files = [System.Collections.Specialized.StringCollection]::new()
        foreach ($page in $pages) { [void]$files.Add($page) }
        if ($factsheetEmitted) {
            # Best-effort: file-drop targets receive the anchor tokens alongside
            # the pages, but a target may ignore any file — this is a convenience,
            # not a guarantee the factsheet arrives.
            [void]$files.Add($factsheetPath)
        }
        $dataObject = [System.Windows.Forms.DataObject]::new()
        $dataObject.SetFileDropList($files)
        if (-not $ImageOnly) {
            $dataObject.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $true, $text)
        }
        [System.Windows.Forms.Clipboard]::SetDataObject($dataObject, $true)

        $factsheetNote = ""
        if ($factsheetEmitted) { $factsheetNote = " plus factsheet.txt (best-effort)" }
        Write-Host "Copied $($pages.Count) page files$factsheetNote to the clipboard$savings."
        $message = "Rendered $($pages.Count) images. All pages are on the clipboard as files; paste into a file-drop target to attach them all."
        Write-Host $message

        try {
            $notify = [System.Windows.Forms.NotifyIcon]::new()
            $notify.Icon = [System.Drawing.SystemIcons]::Information
            $notify.BalloonTipTitle = "pxpipe images ready"
            $notify.BalloonTipText = $message
            $notify.Visible = $true
            $notify.ShowBalloonTip(5000)
            Start-Sleep -Milliseconds 750
            $notify.Dispose()
        } catch {
            Write-Host "Notification unavailable: $($_.Exception.Message)"
        }
    } else {
        $copyPath = $pages[0]
        $image = [System.Drawing.Image]::FromFile($copyPath)
        try {
            if ($ImageOnly) {
                [System.Windows.Forms.Clipboard]::SetImage($image)
            } else {
                # Writes both the bitmap and the original text as separate formats on the
                # same clipboard entry, so pasting into a plain-text target still works.
                $dataObject = [System.Windows.Forms.DataObject]::new()
                $dataObject.SetData([System.Windows.Forms.DataFormats]::Bitmap, $true, $image)
                $dataObject.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $true, $text)
                [System.Windows.Forms.Clipboard]::SetDataObject($dataObject, $true)
            }
        } finally {
            $image.Dispose()
        }

        if ($ImageOnly) {
            Write-Host "Copied $copyPath to the clipboard (image only$savings)."
            if ($anchorsDetected) {
                Write-Warning ("Anchor tokens were detected but the image-only clipboard cannot carry them, " +
                    "and exact values are not reliably recoverable from the image. " +
                    "Run again with -CopyFactsheet to copy them as text.")
            }
        } else {
            Write-Host "Copied $copyPath to the clipboard (with original text as a fallback flavor$savings)."
        }
    }
    Write-Host "Rendered $($pages.Count) page(s) in $OutputDir."
    if ($err) {
        Write-Host ($err -join "`n")
    }
} finally {
    Remove-Item -LiteralPath $stdout, $stderr, $inputFile -Force -ErrorAction SilentlyContinue
}
