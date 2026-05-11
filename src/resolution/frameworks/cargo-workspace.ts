import { ResolutionContext } from '../types';

function getSection(content: string, sectionName: string): string | null {
  const lines = content.split('\n');
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed === `[${sectionName}]`) {
        inSection = true;
      }
      continue;
    }

    if (/^\[[^\]]+\]$/.test(trimmed)) {
      break;
    }

    sectionLines.push(line);
  }

  if (!inSection) return null;
  return sectionLines.join('\n');
}

function extractQuotedValues(valueList: string): string[] {
  const values: string[] = [];
  const valueRegex = /"([^"]+)"|'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = valueRegex.exec(valueList)) !== null) {
    values.push((match[1] ?? match[2] ?? '').trim());
  }
  return values.filter(Boolean);
}

function parseWorkspaceMembers(cargoToml: string): string[] {
  const workspaceSection = getSection(cargoToml, 'workspace');
  if (!workspaceSection) return [];
  const membersMatch = workspaceSection.match(/members\s*=\s*\[([\s\S]*?)\]/m);
  if (!membersMatch) return [];
  return extractQuotedValues(membersMatch[1]!);
}

function parsePackageName(cargoToml: string): string | null {
  const packageSection = getSection(cargoToml, 'package');
  if (!packageSection) return null;
  const packageNameMatch = packageSection.match(/name\s*=\s*["']([^"']+)["']/);
  return packageNameMatch?.[1]?.trim() || null;
}

function addCrateAlias(map: Map<string, string>, crateName: string, memberPath: string): void {
  const normalized = crateName.replace(/-/g, '_');
  map.set(crateName, memberPath);
  map.set(normalized, memberPath);
}

/**
 * Build a map from crate-name aliases to workspace member directory paths.
 * Example: "mytool-core" and "mytool_core" -> "crates/mytool-core"
 */
export function getCargoWorkspaceCrateMap(context: ResolutionContext): Map<string, string> {
  const result = new Map<string, string>();
  const rootCargoToml = context.readFile('Cargo.toml');
  if (!rootCargoToml) return result;

  const members = parseWorkspaceMembers(rootCargoToml);
  for (const memberPath of members) {
    const cleanMemberPath = memberPath.replace(/\\/g, '/').replace(/\/$/, '');
    const memberCargoPath = `${cleanMemberPath}/Cargo.toml`;
    const memberCargoToml = context.readFile(memberCargoPath);
    if (!memberCargoToml) continue;

    const packageName = parsePackageName(memberCargoToml);
    if (!packageName) continue;

    addCrateAlias(result, packageName, cleanMemberPath);
  }

  return result;
}
