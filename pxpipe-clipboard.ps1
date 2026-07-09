param(
    [string]$OutputDir = "$env:USERPROFILE\pxpipe-images",
    [string]$Renderer = "$PSScriptRoot\pxpipe-render-text.mjs"
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

if (Test-Path -LiteralPath $OutputDir) {
    Get-ChildItem -LiteralPath $OutputDir -Filter "page-*.png" -File | Remove-Item -Force
} else {
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

    if ($process.ExitCode -ne 0) {
        throw "Renderer failed with exit code $($process.ExitCode). $($err -join ' ')"
    }

    $pages = @($out | Where-Object { $_ -match '\.png$' })
    if ($pages.Count -eq 0) {
        throw "Renderer did not produce any PNG files. $($err -join ' ')"
    }

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $copyPath = $pages[0]
    $image = [System.Drawing.Image]::FromFile($copyPath)
    try {
        [System.Windows.Forms.Clipboard]::SetImage($image)
    } finally {
        $image.Dispose()
    }

    Write-Host "Copied $copyPath to the clipboard."
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
