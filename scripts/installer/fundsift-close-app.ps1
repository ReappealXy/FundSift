param(
    [Parameter(Mandatory = $true)]
    [string]$Executable
)

$ErrorActionPreference = 'Stop'

function Get-InstalledAppProcess {
    $fileName = [System.IO.Path]::GetFileName($installedPath)
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = '$fileName'"
    $processes | Where-Object { $_.ExecutablePath -eq $installedPath }
}

try {
    $installedPath = [System.IO.Path]::GetFullPath($Executable)
    if (-not @(Get-InstalledAppProcess).Count) {
        exit 0
    }

    Start-Process -FilePath $installedPath -ArgumentList '--fundsift-install-quit' -WindowStyle Hidden
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Milliseconds 250
        if (-not @(Get-InstalledAppProcess).Count) {
            exit 0
        }
    } while ($timer.Elapsed.TotalSeconds -lt 120)

    Write-Output 'FundSift did not exit before the timeout.'
    exit 1
} catch {
    Write-Output $_.Exception.Message
    exit 1
}
