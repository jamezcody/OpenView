$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $projectRoot 'release\release-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'release/release-manifest.json is missing.'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') {
    throw 'The release manifest identity is invalid.'
}
if ($manifest.tag -ne "v$($manifest.version)" -or $manifest.repository -ne 'jamezcody/openview-earth') {
    throw 'The release manifest tag or repository is invalid.'
}

$artifactsRoot = Join-Path $projectRoot 'artifacts'
$artifactDirectory = Join-Path $artifactsRoot $manifest.tag
$buildToken = [guid]::NewGuid().ToString('N')
$stagingDirectory = Join-Path $artifactsRoot ".openview-$($manifest.tag)-build-$buildToken"
$backupDirectory = Join-Path $artifactsRoot ".openview-$($manifest.tag)-backup-$buildToken"
$publishDirectory = Join-Path $stagingDirectory 'publish'
$setupName = "OpenView-Setup-$($manifest.tag).exe"
$setupOutput = Join-Path $stagingDirectory $setupName
$publishedManifest = Join-Path $stagingDirectory 'release-manifest.json'
$checksumOutput = Join-Path $stagingDirectory 'SHA256SUMS.txt'

function Assert-ChildPath([string] $Path, [string] $Parent) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (-not $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify an unexpected path: $fullPath"
    }
}

function Assert-ArchiveMetadata($Descriptor, [string] $Label) {
    if ($null -eq $Descriptor -or $Descriptor.name -notmatch '^openview-[A-Za-z0-9.-]+\.tar\.gz$') {
        throw "The $Label archive name is invalid."
    }
    if ($Descriptor.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw "The $Label archive checksum is invalid."
    }
    $compressed = [long]$Descriptor.compressedBytes
    $files = [long]$Descriptor.fileCount
    $uncompressed = [long]$Descriptor.uncompressedBytes
    if ($compressed -le 0 -or $files -le 0 -or $uncompressed -le 0 `
        -or $compressed -gt [long]$Descriptor.maximumCompressedBytes `
        -or $files -gt [long]$Descriptor.maximumFileCount `
        -or $uncompressed -gt [long]$Descriptor.maximumUncompressedBytes) {
        throw "The $Label archive sizes or limits are invalid."
    }
}

function Assert-ArchiveFile($Descriptor, [string] $Label, [bool] $Required) {
    $path = Join-Path $artifactDirectory $Descriptor.name
    Assert-ChildPath $path $artifactDirectory
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        if ($Required) { throw "The required $Label archive is missing: $path" }
        return $null
    }
    $item = Get-Item -LiteralPath $path
    if ($item.Length -ne [long]$Descriptor.compressedBytes) {
        throw "The $Label archive size does not match release-manifest.json."
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
    if (-not $hash.Equals([string]$Descriptor.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The $Label archive SHA-256 does not match release-manifest.json."
    }
    return $path
}

Assert-ArchiveMetadata $manifest.runtimeArchive 'runtime'
Assert-ArchiveMetadata $manifest.dataArchive 'data'
New-Item -ItemType Directory -Force -Path $artifactsRoot | Out-Null
if (-not (Test-Path -LiteralPath $artifactDirectory -PathType Container)) {
    throw "The release asset directory is missing: $artifactDirectory"
}
$runtimeArchive = Assert-ArchiveFile $manifest.runtimeArchive 'runtime' $true
$dataArchive = Assert-ArchiveFile $manifest.dataArchive 'data' $true

Assert-ChildPath $artifactDirectory $artifactsRoot
Assert-ChildPath $stagingDirectory $artifactsRoot
Assert-ChildPath $backupDirectory $artifactsRoot
Assert-ChildPath $publishDirectory $stagingDirectory
Assert-ChildPath $setupOutput $stagingDirectory
Assert-ChildPath $publishedManifest $stagingDirectory
Assert-ChildPath $checksumOutput $stagingDirectory
if ((Test-Path -LiteralPath $stagingDirectory) -or (Test-Path -LiteralPath $backupDirectory)) {
    throw 'A unique installer build workspace unexpectedly already exists.'
}

New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
$generatedNames = @($setupName, 'release-manifest.json', 'SHA256SUMS.txt')
$promoted = $false
try {
    foreach ($item in Get-ChildItem -LiteralPath $artifactDirectory -Force) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Release assets cannot contain reparse points: $($item.FullName)"
        }
        if ($item.PSIsContainer) {
            if ($item.Name -eq 'publish') { continue }
            throw "Release assets must be regular files: $($item.FullName)"
        }
        if ($generatedNames -contains $item.Name) { continue }
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $stagingDirectory $item.Name)
    }

    Push-Location $projectRoot
    try {
        & dotnet publish 'installer\OpenView.Setup\OpenView.Setup.csproj' `
            --configuration Release `
            --runtime win-x64 `
            --self-contained true `
            "-p:Version=$($manifest.version)" `
            "-p:FileVersion=$($manifest.version).0" `
            "-p:InformationalVersion=$($manifest.version)" `
            --output $publishDirectory
        if ($LASTEXITCODE -ne 0) {
            throw "Setup publish failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    $publishedExecutable = Join-Path $publishDirectory 'OpenView.Setup.exe'
    if (-not (Test-Path -LiteralPath $publishedExecutable -PathType Leaf)) {
        throw 'The published setup executable is missing.'
    }
    Copy-Item -LiteralPath $publishedExecutable -Destination $setupOutput
    Copy-Item -LiteralPath $manifestPath -Destination $publishedManifest

    $stagedRuntimeArchive = Join-Path $stagingDirectory $manifest.runtimeArchive.name
    $stagedDataArchive = Join-Path $stagingDirectory $manifest.dataArchive.name
    $selfTestArguments = @('--self-test', '--sidecar-dir', ('"' + $stagingDirectory + '"'))
    $selfTest = Start-Process -FilePath $setupOutput -ArgumentList $selfTestArguments `
        -WindowStyle Hidden -Wait -PassThru
    if ($selfTest.ExitCode -ne 0) {
        throw "The published setup self-test failed with exit code $($selfTest.ExitCode)."
    }

    $checksumFiles = @($publishedManifest, $setupOutput, $stagedRuntimeArchive, $stagedDataArchive)
    $checksumLines = foreach ($path in $checksumFiles) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
        "$hash  $([System.IO.Path]::GetFileName($path))"
    }
    [System.IO.File]::WriteAllLines(
        $checksumOutput,
        $checksumLines,
        [System.Text.UTF8Encoding]::new($false)
    )
    Remove-Item -LiteralPath $publishDirectory -Recurse -Force

    Move-Item -LiteralPath $artifactDirectory -Destination $backupDirectory
    try {
        Move-Item -LiteralPath $stagingDirectory -Destination $artifactDirectory
        $promoted = $true
    } catch {
        Move-Item -LiteralPath $backupDirectory -Destination $artifactDirectory
        throw
    }
} finally {
    if (-not $promoted -and (Test-Path -LiteralPath $stagingDirectory)) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
    }
}

if (Test-Path -LiteralPath $backupDirectory) {
    try { Remove-Item -LiteralPath $backupDirectory -Recurse -Force }
    catch { Write-Warning "The previous validated artifact directory remains at $backupDirectory" }
}

$finalFiles = @(
    (Join-Path $artifactDirectory 'release-manifest.json'),
    (Join-Path $artifactDirectory $setupName),
    (Join-Path $artifactDirectory $manifest.runtimeArchive.name),
    (Join-Path $artifactDirectory $manifest.dataArchive.name)
)
Get-Item -LiteralPath $finalFiles | Select-Object Name, Length
