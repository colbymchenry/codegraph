# CodeGraph standalone installer for Windows (PowerShell).
#
# Downloads a self-contained bundle (a vendored Node runtime + the app) from
# GitHub Releases. No Node.js, no build tools required.
#
#   irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
#
# Re-run to upgrade. To uninstall: remove $env:LOCALAPPDATA\codegraph and drop
# its \current\bin entry from your user PATH.
#
# Environment:
#   CODEGRAPH_VERSION      release tag to install (default: latest)
#   CODEGRAPH_INSTALL_DIR  install location (default: %LOCALAPPDATA%\codegraph)

$ErrorActionPreference = 'Stop'
$repo = 'colbymchenry/codegraph'
$installDir = if ($env:CODEGRAPH_INSTALL_DIR) { $env:CODEGRAPH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'codegraph' }

# 1. Detect architecture -> target matching the release archives.
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$target = "win32-$arch"

# 2. Resolve the version (latest release unless pinned).
#    Use the releases/latest *web* redirect first — the unauthenticated GitHub API
#    is rate-limited to 60 requests/hour per IP and returns 403 on shared hosts
#    and CI (issue #325). The redirect has no such limit. Fall back to the API.
$version = $env:CODEGRAPH_VERSION
if (-not $version) {
  try {
    # Follow the redirect and read the final URL (no API call, no rate limit).
    $resp = Invoke-WebRequest -Uri "https://github.com/$repo/releases/latest" -UseBasicParsing
    if ($resp.BaseResponse.ResponseUri.AbsoluteUri -match '/releases/tag/(.+)') {
      $version = $Matches[1]
    }
  } catch { }
}
if (-not $version) {
  try {
    $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
  } catch { }
}
# Release tags are vX.Y.Z; accept a bare X.Y.Z in CODEGRAPH_VERSION too.
if ($version -and $version -notmatch '^v') { $version = "v$version" }
if (-not $version) { throw "codegraph: could not resolve latest version; set CODEGRAPH_VERSION (e.g. CODEGRAPH_VERSION=v0.9.7)." }

# 3. Download + extract the bundle into a stable 'current' dir (overwritten on upgrade).
$url = "https://github.com/$repo/releases/download/$version/codegraph-$target.zip"
Write-Host "Installing CodeGraph $version ($target)..."
$tmp = Join-Path $env:TEMP ("cg-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'cg.zip'
Invoke-WebRequest -Uri $url -OutFile $zip

$dest = Join-Path $installDir 'current'
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force
# Archives contain a top-level codegraph-<target>\ dir; flatten it.
$inner = Join-Path $dest "codegraph-$target"
if (Test-Path $inner) {
  Get-ChildItem -Force $inner | Move-Item -Destination $dest -Force
  Remove-Item -Recurse -Force $inner
}
Remove-Item -Recurse -Force $tmp

# 4. Put the launcher dir on the user's PATH.
$binDir = Join-Path $dest 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
  Write-Host "Added $binDir to your PATH (restart your terminal to pick it up)."
}

Write-Host "Installed to $dest"
Write-Host "Run: codegraph --help"
