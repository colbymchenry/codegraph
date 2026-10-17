/**
 * Cargo Workspace Resolver Helper
 *
 * Parses a project's root Cargo.toml and member crate manifests to
 * build a crate-name -> member-directory map. Used by the Rust
 * resolver to resolve `use crate_name::...` references that point
 * into workspace member crates.
 */

import picomatch from 'picomatch';
import { ResolutionContext } from '../types';

const GLOB_CHARS = /[*?[\]{}!]/;
const SKIP_DIRS = new Set(['target', 'node_modules', '.git', 'dist', 'build']);
const MAX_GLOB_WALK_DEPTH = 5;

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
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let current = '';

  for (const ch of valueList) {
    if (!quote) {
      if (ch === '"' || ch === "'") {
        quote = ch;
        current = '';
      }
      continue;
    }

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === quote) {
      values.push(current.trim());
      quote = null;
      current = '';
      continue;
    }

    current += ch;
  }

  return values.filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getArrayValue(section: string, key: string): string | null {
  const keyRegex = new RegExp(`\\b${escapeRegExp(key)}\\b\\s*=`, 'm');
  const keyMatch = keyRegex.exec(section);
  if (!keyMatch) return null;

  let i = keyMatch.index + keyMatch[0].length;
  while (i < section.length && /\s/.test(section.charAt(i))) i++;
  if (section.charAt(i) !== '[') return null;
  i++;

  let inQuote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 1;
  const start = i;

  while (i < section.length) {
    const ch = section.charAt(i);

    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      i++;
      continue;
    }

    if (ch === '[') {
      depth++;
      i++;
      continue;
    }

    if (ch === ']') {
      depth--;
      if (depth === 0) {
        return section.slice(start, i);
      }
      i++;
      continue;
    }

    i++;
  }

  return null;
}

function parseWorkspaceMembers(cargoToml: string): string[] {
  const workspaceSection = getSection(cargoToml, 'workspace');
  if (!workspaceSection) return [];
  const membersValue = getArrayValue(workspaceSection, 'members');
  if (!membersValue) return [];
  return extractQuotedValues(membersValue);
}

function parsePackageName(cargoToml: string): string | null {
  const packageSection = getSection(cargoToml, 'package');
  if (!packageSection) return null;
  const packageNameMatch = packageSection.match(/name\s*=\s*["']([^"'\n]+)["']/);
  return packageNameMatch?.[1]?.trim() ?? null;
}

function addCrateAlias(map: Map<string, string>, crateName: string, memberPath: string): void {
  const normalized = crateName.replace(/-/g, '_');
  map.set(crateName, memberPath);
  if (normalized !== crateName) {
    map.set(normalized, memberPath);
  }
}

function cleanPath(memberPath: string): string {
  return memberPath.replace(/\\/g, '/').replace(/\/$/, '');
}

function expandGlobMember(member: string, context: ResolutionContext): string[] {
  if (!context.listDirectories) return [];

  const firstGlobIdx = member.search(GLOB_CHARS);
  const staticPrefix = member
    .slice(0, firstGlobIdx)
    .replace(/[^/]*$/, '')
    .replace(/\/$/, '');

  const matcher = picomatch(member, { dot: false });
  const matches: string[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > MAX_GLOB_WALK_DEPTH) return;
    const children = context.listDirectories!(dir);
    for (const child of children) {
      if (SKIP_DIRS.has(child) || child.startsWith('.')) continue;
      const rel = dir === '.' ? child : `${dir}/${child}`;
      if (matcher(rel) && !seen.has(rel)) {
        seen.add(rel);
        matches.push(rel);
      }
      walk(rel, depth + 1);
    }
  }

  walk(staticPrefix || '.', 0);
  return matches;
}

function expandMembers(members: string[], context: ResolutionContext): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const candidates = GLOB_CHARS.test(member)
      ? expandGlobMember(member, context)
      : [member];
    for (const candidate of candidates) {
      const cleaned = cleanPath(candidate);
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      expanded.push(cleaned);
    }
  }
  return expanded;
}

/** Join a manifest directory and a relative `path = "…"`, posix and normalized; null when it leaves the project. */
function joinInsideProject(manifestDir: string, relPath: string): string | null {
  const parts: string[] = [];
  for (const seg of `${manifestDir}/${relPath}`.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/**
 * The `path` dependencies a manifest declares, by the name code writes them
 * (the dependency KEY, which a `package = "…"` rename makes differ from the
 * crate's own name): `sim = { path = "crates/sim" }` in `[dependencies]`,
 * `[dev-dependencies]`, `[build-dependencies]`, target-specific tables, and a
 * workspace root's `[workspace.dependencies]`; also the `[dependencies.sim]`
 * table form. Paths resolve against the manifest's directory.
 */
function parsePathDependencies(cargoToml: string, manifestDir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let inDeps = false;
  let tableDep: string | null = null;
  for (const raw of cargoToml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const table = header[1]!.trim();
      tableDep = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(table)?.[1] ?? null;
      inDeps = /(?:^|\.)(?:dev-|build-)?dependencies$/.test(table);
      continue;
    }
    if (tableDep) {
      const p = /^path\s*=\s*["']([^"']+)["']/.exec(line)?.[1];
      const dir = p ? joinInsideProject(manifestDir, p) : null;
      if (dir) out.push([tableDep, dir]);
      continue;
    }
    if (!inDeps) continue;
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*\{(.*)\}\s*$/.exec(line);
    const p = entry ? /\bpath\s*=\s*["']([^"']+)["']/.exec(entry[2]!)?.[1] : undefined;
    const dir = p ? joinInsideProject(manifestDir, p) : null;
    if (entry && dir) out.push([entry[1]!, dir]);
  }
  return out;
}

/**
 * Build a map from crate-name aliases to workspace member directory paths.
 * Example: "mytool-core" and "mytool_core" -> "crates/mytool-core"
 *
 * Supports glob members (e.g. `members = ["crates/*"]`) via picomatch
 * when the context exposes `listDirectories`. Also maps every in-project
 * `path` dependency the root or a member manifest declares, by its dependency
 * key — a renamed (`core_sim = { path = "../sim", package = "sim" }`) or
 * non-member (`vendor/foo`) crate is reached the same way a member is.
 */
export function getCargoWorkspaceCrateMap(context: ResolutionContext): Map<string, string> {
  const result = new Map<string, string>();
  const rootCargoToml = context.readFile('Cargo.toml');
  if (!rootCargoToml) return result;

  const rawMembers = parseWorkspaceMembers(rootCargoToml);
  const members = expandMembers(rawMembers, context);
  const manifests: Array<[string, string]> = [['', rootCargoToml]];

  for (const memberPath of members) {
    const memberCargoPath = `${memberPath}/Cargo.toml`;
    const memberCargoToml = context.readFile(memberCargoPath);
    if (!memberCargoToml) continue;
    manifests.push([memberPath, memberCargoToml]);

    const packageName = parsePackageName(memberCargoToml);
    if (!packageName) continue;

    addCrateAlias(result, packageName, memberPath);
  }

  // The map is workspace-wide, but a dependency key is per manifest: two crates
  // may bind `util` to different directories. A key with more than one target
  // is dropped — unresolved beats resolving one crate's `util::` to the other's.
  const depDirs = new Map<string, Set<string>>();
  for (const [manifestDir, manifest] of manifests) {
    for (const [depName, depDir] of parsePathDependencies(manifest, manifestDir)) {
      if (result.has(depName) || !context.readFile(`${depDir}/Cargo.toml`)) continue;
      const key = depName.replace(/-/g, '_');
      const dirs = depDirs.get(key) ?? new Set<string>();
      dirs.add(depDir);
      depDirs.set(key, dirs);
    }
  }
  for (const [manifestDir, manifest] of manifests) {
    for (const [depName, depDir] of parsePathDependencies(manifest, manifestDir)) {
      if (result.has(depName) || !context.readFile(`${depDir}/Cargo.toml`)) continue;
      if (depDirs.get(depName.replace(/-/g, '_'))!.size > 1) continue;
      addCrateAlias(result, depName, depDir);
    }
  }

  return result;
}

/**
 * The directory holding a crate's library root (`lib.rs`), relative to the
 * project: `[lib] path = "…"`'s directory when the manifest sets one, else
 * `<crate>/src`.
 */
export function cargoCrateSourceDir(crateDir: string, context: ResolutionContext): string {
  const base = crateDir === '.' ? '' : crateDir;
  const lib = getSection(context.readFile(base ? `${base}/Cargo.toml` : 'Cargo.toml') ?? '', 'lib');
  const libPath = lib ? /^\s*path\s*=\s*["']([^"']+)["']/m.exec(lib)?.[1] : undefined;
  const libDir = libPath ? joinInsideProject(base, libPath.replace(/\/?[^/]*$/, '')) : null;
  return libDir ?? (base ? `${base}/src` : 'src');
}
