#!/usr/bin/env bash
# PowerShell completion smoke. Dot-sources the installed script in a
# pwsh subshell and drives `TabExpansion2` (the non-interactive
# equivalent of `complete -C` for fish). Asserts completion content.
#
# We write the pwsh script to a temp file and pass it via `-File`
# instead of inlining via `-Command` — quoting pwsh inside a bash
# single-quoted string is unmanageable (the dollar signs needed for
# $env:VAR collide with bash's expansion rules and break silently).
set -euo pipefail

PS_PATH="${PS_PATH:-$HOME/.config/powershell/codegraph.ps1}"
export PS_PATH

tmp=$(mktemp /tmp/codegraph-smoke-XXXXXX.ps1)
trap 'rm -f "$tmp"' EXIT

cat > "$tmp" <<'PSSCRIPT'
$ErrorActionPreference = "Stop"
. $env:PS_PATH

$script:fail = $false

function Assert-Contains {
    param([string]$Label, [string]$Needle, [string[]]$Haystack)
    if ($Haystack -notcontains $Needle) {
        Write-Host "FAIL [powershell:$Label]: missing '$Needle' in [$($Haystack -join ', ')]"
        $script:fail = $true
    }
}

function Assert-NonEmpty {
    param([string]$Label, [object]$Result)
    if ($Result.CompletionMatches.Count -eq 0) {
        Write-Host "FAIL [powershell:$Label]: expected non-empty completions"
        $script:fail = $true
    }
}

# 1. Top-level subcommand list.
$r = TabExpansion2 -inputScript "codegraph " -cursorColumn ("codegraph ".Length)
Assert-NonEmpty "top-level" $r
$names = $r.CompletionMatches.CompletionText
Assert-Contains "top-level/init"        "init"        $names
Assert-Contains "top-level/query"       "query"       $names
Assert-Contains "top-level/completions" "completions" $names

# 2. Top-level flags surface from the root switch arm.
Assert-Contains "top-level/--help"    "--help"    $names
Assert-Contains "top-level/--version" "--version" $names

# 3. Subcommand flag completion.
$line = "codegraph init -"
$r = TabExpansion2 -inputScript $line -cursorColumn $line.Length
Assert-NonEmpty "init/-" $r
$flags = $r.CompletionMatches.CompletionText
Assert-Contains "init/--index" "--index" $flags
Assert-Contains "init/-i"      "-i"      $flags

if ($script:fail) { exit 1 } else { Write-Output "powershell smoke OK"; exit 0 }
PSSCRIPT

pwsh -NoProfile -File "$tmp"
