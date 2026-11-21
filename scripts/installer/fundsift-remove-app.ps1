param(
    [Parameter(Mandatory = $true)]
    [string]$Directory,
    [Parameter(Mandatory = $true)]
    [string]$Manifest
)

$ErrorActionPreference = 'Stop'

$installPath = [IO.Path]::GetFullPath($Directory)
[string[]]$paths = Get-Content -Raw -Encoding UTF8 -LiteralPath $Manifest | ConvertFrom-Json
if (-not $paths.Count -or -not (Test-Path -LiteralPath $installPath -PathType Container)) {
    exit 1
}

function Assert-RegularPath {
    param([string]$Path)
    $item = Get-Item -Force -LiteralPath $Path
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'The installation path contains a link or junction.'
    }
    $item
}

$stage = $null
$moved = [Collections.Generic.List[string]]::new()
$installedDirs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
try {
    # A renamed file stays on the same volume. If any rename fails, put prior files back.
    $null = Assert-RegularPath $installPath
    $stagePath = Join-Path $installPath ('.fundsift-uninstall-' + [Guid]::NewGuid().ToString('N'))
    $stage = (New-Item -Path $stagePath -ItemType Directory).FullName
    foreach ($relativePath in $paths) {
        $installedFile = Join-Path $installPath $relativePath
        $parent = Split-Path -Parent $relativePath
        while ($parent) {
            if ($installedDirs.Add($parent)) {
                $parentPath = Join-Path $installPath $parent
                if (Test-Path -LiteralPath $parentPath) {
                    $item = Assert-RegularPath $parentPath
                    if (-not $item.PSIsContainer) { throw 'Expected an installed program directory.' }
                }
            }
            $parent = Split-Path -Parent $parent
        }
        if (Test-Path -LiteralPath $installedFile) {
            $item = Assert-RegularPath $installedFile
            if ($item.PSIsContainer) { throw 'Expected an installed program file.' }
            $stagedFile = Join-Path $stage $relativePath
            $null = [IO.Directory]::CreateDirectory((Split-Path -Parent $stagedFile))
            [IO.File]::Move($installedFile, $stagedFile)
            $moved.Add($relativePath)
        }
    }
} catch {
    Write-Output $_.Exception.Message
    if ($stage) {
        try {
            foreach ($relativePath in $moved) {
                [IO.File]::Move((Join-Path $stage $relativePath), (Join-Path $installPath $relativePath))
            }
            [IO.Directory]::Delete($stage, $true)
        } catch {
            Write-Output "Could not restore installed program files. They remain at $stage"
        }
    }
    exit 1
}

[IO.Directory]::Delete($stage, $true)
foreach ($dir in $installedDirs | Sort-Object Length -Descending) {
    $installedDir = Join-Path $installPath $dir
    if ((Test-Path -LiteralPath $installedDir) -and
        -not ([IO.Directory]::EnumerateFileSystemEntries($installedDir) | Select-Object -First 1)) {
        [IO.Directory]::Delete($installedDir)
    }
}
