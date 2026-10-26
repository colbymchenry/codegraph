# CodeGraph standalone installer for Windows (PowerShell).
#
# Downloads a self-contained bundle (a vendored Node runtime + the app) from
# GitHub Releases. No Node.js, no build tools required.
#
#   irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
#
# Upgrade with `codegraph upgrade` (or just re-run this -- safe even while agent
# sessions are running CodeGraph). To uninstall: remove
# $env:LOCALAPPDATA\codegraph and drop its \current\bin entry from your user PATH.
#
# Environment:
#   CODEGRAPH_VERSION      release tag to install (default: latest)
#   CODEGRAPH_INSTALL_DIR  install location (default: %LOCALAPPDATA%\codegraph)

$ErrorActionPreference = 'Stop'

# >>> Install-CodeGraphFiles -- keep identical to WINDOWS_SWAP_FUNCTION in src/upgrade/index.ts
function Install-CodeGraphFiles([string]$Stage, [string]$Dest) {
  # Move an unpacked bundle into $Dest. Windows can't overwrite or delete a
  # running node.exe or a loaded .node addon, but it can rename one, so every
  # file being replaced (or dropped by the new version) is first renamed aside
  # to <name>.old-<token>. Any failure puts every file back, so the install is
  # never left half-replaced or without its node.exe.
  $ErrorActionPreference = 'Stop'
  $stageDir = (Resolve-Path -LiteralPath $Stage).ProviderPath.TrimEnd('\')
  foreach ($need in 'node.exe', 'bin\codegraph.cmd') {
    if (-not (Test-Path -LiteralPath (Join-Path $stageDir $need))) { throw "The CodeGraph download is incomplete (no $need); nothing was changed." }
  }
  $token = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $asideName = '\.old-[0-9a-f]{8,32}$'
  $files = @{}; $dirs = @{}
  foreach ($i in @(Get-ChildItem -LiteralPath $stageDir -Recurse -Force)) {
    $rel = $i.FullName.Substring($stageDir.Length)
    if ($i.PSIsContainer) { $dirs[$rel] = $true } else { $files[$rel] = $true }
  }
  $undo = New-Object System.Collections.ArrayList
  function Move-Logged([string]$From, [string]$To) { [IO.File]::Move($From, $To); [void]$undo.Add(@($From, $To)) }
  function Undo-Logged {
    $lost = 0
    for ($n = $undo.Count - 1; $n -ge 0; $n--) {
      $u = $undo[$n]
      try { if ($u.Count -eq 2) { [IO.File]::Move($u[1], $u[0]) } else { [IO.Directory]::Delete($u[0]) } } catch { if ($u.Count -eq 2) { $lost++ } }
    }
    $undo.Clear()
    $lost
  }
  $done = $false; $at = $Dest
  try {
    if (-not (Test-Path -LiteralPath $Dest)) { [void][IO.Directory]::CreateDirectory($Dest); [void]$undo.Add(@($Dest)) }
    $destDir = (Resolve-Path -LiteralPath $Dest).ProviderPath.TrimEnd('\')
    foreach ($f in @(Get-ChildItem -LiteralPath $destDir -Recurse -Force -File)) {
      if (-not $files.ContainsKey($f.FullName.Substring($destDir.Length)) -and $f.Name -notmatch $asideName) {
        $at = $f.FullName; Move-Logged $at "$at.old-$token"
      }
    }
    foreach ($rel in @($dirs.Keys | Sort-Object Length)) {
      $at = $destDir + $rel
      if (-not [IO.Directory]::Exists($at)) { [void][IO.Directory]::CreateDirectory($at); [void]$undo.Add(@($at)) }
    }
    foreach ($rel in @($files.Keys)) {
      $at = $destDir + $rel
      if ([IO.File]::Exists($at)) { Move-Logged $at "$at.old-$token" }
      Move-Logged ($stageDir + $rel) $at
    }
    $done = $true
  } catch {
    $x = $_.Exception; while ($x.InnerException) { $x = $x.InnerException }
    $lost = Undo-Logged
    $msg = "Could not replace $at ($($x.Message))."
    if ($lost) {
      $msg += " $lost file(s) could not be put back, so the install may not start. Close your agent sessions and any running codegraph commands, then reinstall: irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex"
    } else {
      $msg += " Nothing was changed: the existing install still works. If another program has CodeGraph's files open, close your agent sessions (they run the CodeGraph MCP server) and any running codegraph commands, then try again."
    }
    $e = New-Object System.Exception($msg); $e.Data['codegraphDamaged'] = [bool]$lost; throw $e
  } finally {
    # Interrupted (Ctrl+C) without reaching catch: still put everything back.
    if (-not $done) { [void](Undo-Logged) }
  }
  # Delete what this run and earlier ones renamed aside. A file a running
  # process still holds can't be deleted yet; the next install retries it.
  foreach ($f in @(Get-ChildItem -LiteralPath $destDir -Recurse -Force -File -ErrorAction SilentlyContinue)) {
    if ($f.Name -match $asideName) { try { [IO.File]::Delete($f.FullName) } catch {} }
  }
  foreach ($d in @(Get-ChildItem -LiteralPath $destDir -Recurse -Force -Directory -ErrorAction SilentlyContinue | Sort-Object { $_.FullName.Length } -Descending)) {
    if (-not $dirs.ContainsKey($d.FullName.Substring($destDir.Length))) { try { [IO.Directory]::Delete($d.FullName) } catch {} }
  }
}
# <<< Install-CodeGraphFiles

$repo = 'colbymchenry/codegraph'
$installDir = if ($env:CODEGRAPH_INSTALL_DIR) { $env:CODEGRAPH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'codegraph' }

# 1. Detect architecture -> target matching the release archives.
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
$target = "win32-$arch"

# 2. Resolve the version (latest release unless pinned).
$version = $env:CODEGRAPH_VERSION
if (-not $version) {
  $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
}
if (-not $version) { throw "codegraph: could not resolve latest version; set CODEGRAPH_VERSION." }

# 3. Download the bundle and unpack it next to the stable 'current' dir (same
# volume, so moving it in is renames, not copies), then move it into 'current'.
# 'current' is never deleted wholesale: a CodeGraph process that is still
# running (an agent session's MCP server) holds node.exe and the native kernel,
# which can't be deleted -- Install-CodeGraphFiles renames them aside instead.
$url = "https://github.com/$repo/releases/download/$version/codegraph-$target.zip"
Write-Host "Installing CodeGraph $version ($target)..."
$tmp = Join-Path $env:TEMP ("cg-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp 'cg.zip'
$dest = Join-Path $installDir 'current'
$stage = Join-Path $installDir ('.staging-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
try {
  Invoke-WebRequest -Uri $url -OutFile $zip
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  # Archives contain a top-level codegraph-<target>\ dir.
  $inner = Join-Path $stage "codegraph-$target"
  Install-CodeGraphFiles $(if (Test-Path $inner) { $inner } else { $stage }) $dest
} finally {
  Remove-Item -LiteralPath $stage, $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# 4. Put the launcher dir on the user's PATH.
$binDir = Join-Path $dest 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
  Write-Host "Added $binDir to your PATH (restart your terminal to pick it up)."
}

Write-Host "Installed to $dest"

# 5. Warn if a different codegraph earlier on PATH will shadow this install.
# Most often a stale `npm i -g @colbymchenry/codegraph`, whose launcher keeps
# running its own version-pinned bundle — so `codegraph --version` disagrees
# with what we just installed (issue #1071). Check both the persisted PATH a
# fresh shell sees (Machine + User) and this session's PATH (catches dirs a
# shell profile injects, e.g. conda / npm).
$expected = Join-Path $binDir 'codegraph.cmd'
function Find-FirstCodegraph([string]$pathStr) {
  foreach ($dir in ($pathStr -split ';')) {
    if (-not $dir) { continue }
    foreach ($leaf in @('codegraph.cmd', 'codegraph.exe', 'codegraph.bat', 'codegraph.ps1')) {
      $cand = Join-Path $dir $leaf
      if (Test-Path -LiteralPath $cand) { return $cand }
    }
  }
  return $null
}
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$freshPath = ((@($machinePath, [Environment]::GetEnvironmentVariable('Path', 'User')) | Where-Object { $_ }) -join ';')
$shadow = $null
foreach ($winner in @((Find-FirstCodegraph $env:Path), (Find-FirstCodegraph $freshPath))) {
  if ($winner -and ($winner -ne $expected)) { $shadow = $winner; break }
}
if ($shadow) {
  Write-Warning "Another codegraph is earlier on your PATH and will run instead of this install:"
  Write-Warning "  $shadow"
  Write-Warning "  (this install: $expected)"
  Write-Warning "If 'codegraph --version' shows an unexpected version, remove the other copy"
  Write-Warning "(e.g. 'npm rm -g @colbymchenry/codegraph') or put '$binDir' first on your PATH."
}

Write-Host "Run: codegraph --help"
