param(
    [string]$OutputDir = "$env:USERPROFILE\pxpipe-images",
    [string]$Renderer = "$PSScriptRoot\pxpipe-render-text.mjs",
    # PNG only, no text flavor — for apps whose paste handler prefers text over
    # image whenever both are present on the clipboard.
    [switch]$ImageOnly
)

$ErrorActionPreference = "Stop"

function Quote-ProcessArgument {
    param([string]$Value)
    '"' + ($Value -replace '\\', '\\' -replace '"', '\"') + '"'
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
    Set-Content -LiteralPath $inputFile -Value $text -Encoding UTF8

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "node"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.Arguments = @(
        Quote-ProcessArgument $Renderer
        Quote-ProcessArgument $inputFile
        Quote-ProcessArgument $OutputDir
    ) -join " "

    $process = [System.Diagnostics.Process]::Start($psi)
    $outText = $process.StandardOutput.ReadToEnd()
    $errText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    Set-Content -LiteralPath $stdout -Value $outText -Encoding UTF8
    Set-Content -LiteralPath $stderr -Value $errText -Encoding UTF8
    $out = $outText -split "\r?\n" | Where-Object { $_ }
    $err = $errText -split "\r?\n" | Where-Object { $_ }

    if ($process.ExitCode -eq 2) {
        # Renderer declined: imaging wouldn't save tokens. Clipboard was never touched.
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

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

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
        Write-Host "Copied $copyPath to the clipboard (image only)."
    } else {
        Write-Host "Copied $copyPath to the clipboard (with original text as a fallback flavor)."
    }
    Write-Host "Rendered $($pages.Count) page(s) in $OutputDir."
    if ($pages.Count -gt 1) {
        $message = "Rendered $($pages.Count) images. Page 1 is on the clipboard; opening the folder for the remaining pages."
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

        Start-Process explorer.exe -ArgumentList (Quote-ProcessArgument $OutputDir) | Out-Null
    }
    if ($err) {
        Write-Host ($err -join "`n")
    }
} finally {
    Remove-Item -LiteralPath $stdout, $stderr, $inputFile -Force -ErrorAction SilentlyContinue
}
