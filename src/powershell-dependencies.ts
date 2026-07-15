export interface PowershellDependencySpec {
  kind: 'module' | 'dot-source';
  relativePath: string;
  index: number;
  signature: string;
}

function relativeScriptPath(args: string): string | undefined {
  return args.match(/Join-Path\s+\$PSScriptRoot\s+['"]([^'"]+)['"]/i)?.[1]
    ?? args.match(/['"]\$PSScriptRoot[\\/]([^'"]+)['"]/i)?.[1]
    ?? args.match(/^['"]([^'"]+\.(?:psm1|psd1|ps1))['"]/i)?.[1]
    ?? args.match(/^([^\s)]+\.(?:psm1|psd1|ps1))\b/i)?.[1];
}

/** Static local PowerShell dependencies that establish a callable scope. */
export function extractPowershellDependencies(source: string): PowershellDependencySpec[] {
  const result: PowershellDependencySpec[] = [];
  for (const match of source.matchAll(/^[ \t]*Import-Module\s+([^\r\n]+)/gim)) {
    const relativePath = relativeScriptPath(match[1]!);
    if (!relativePath) continue;
    result.push({ kind: 'module', relativePath, index: match.index ?? 0, signature: match[0].trim() });
  }
  for (const match of source.matchAll(/^[ \t]*\.[ \t]+([^\r\n]+)/gim)) {
    const relativePath = relativeScriptPath(match[1]!);
    if (!relativePath) continue;
    result.push({ kind: 'dot-source', relativePath, index: match.index ?? 0, signature: match[0].trim() });
  }
  return result.sort((a, b) => a.index - b.index);
}
