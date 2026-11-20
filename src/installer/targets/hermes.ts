/**
 * Hermes Agent target.
 *
 * Hermes reads MCP servers from `$HERMES_HOME/config.yaml` under the
 * top-level `mcp_servers` key. We add one entry:
 *
 *   mcp_servers.codegraph -> `codegraph serve --mcp`
 *
 * and nothing else. In particular we never write `platform_toolsets` (#2485).
 * With no MCP server named in a platform's list, Hermes loads every enabled
 * MCP server on that platform; naming one, as `<server>` or `mcp-<server>`,
 * turns the list into an allowlist of the servers named
 * (`hermes_cli/tools_config.py` `_merge_mcp_servers` in NousResearch/hermes-agent
 * v0.22.4; the same rule, bare names only, dates back to May 2026). Earlier
 * installs appended `mcp-codegraph` to `platform_toolsets.cli`: Hermes up to
 * 0.22.2 reported it as an unknown toolset on every start, and 0.22.4 reads
 * it as naming codegraph, which hides every other MCP server from CLI
 * sessions. Install and refresh take that line out again
 * (`healCliToolsetEntry`).
 *
 * An existing `mcp_servers.codegraph` entry belongs to the user: its values
 * (an absolute command path, timeouts, `enabled: false`, env) are never
 * rewritten. A refresh only adds `command` / `args` when one is missing.
 *
 * The file is edited as text, line by line, so comments and formatting
 * survive; Hermes itself writes it with a comment-preserving round-trip.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import { atomicWriteFileSync, joinText, splitText } from './shared';

class HermesTarget implements AgentTarget {
  readonly id = 'hermes' as const;
  readonly displayName = 'Hermes Agent';
  readonly docsUrl = 'https://hermes-agent.nousresearch.com';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = configPath();
    const content = readText(file);
    const installed = fs.existsSync(hermesHome()) || fs.existsSync(file);
    return {
      installed,
      alreadyConfigured: findCodeGraphServer(splitText(content).lines) !== null,
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Hermes Agent uses $HERMES_HOME/config.yaml; re-run with --location=global.'],
      };
    }
    const { file, notes } = writeHermesConfig();
    return {
      files: [file],
      notes: [...notes, 'Start a new Hermes session for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const file = configPath();
    if (!fs.existsSync(file)) {
      return { files: [{ path: file, action: 'not-found' }] };
    }

    const text = splitText(readText(file));
    const notes: string[] = [];
    const server = findCodeGraphServer(text.lines);
    let removed = false;
    if (server?.inFlowParent) {
      notes.push(`${file} sets mcp_servers.codegraph inside a one-line mcp_servers mapping (line ${server.line + 1}), which CodeGraph can't edit safely. Remove it from there yourself.`);
    } else if (server) {
      text.lines.splice(server.line, server.end - server.line);
      removed = true;
    }
    // The line earlier installs wrote, and `codegraph` (what a refresh made of
    // it in an allowlist): with the server gone, either would be unknown.
    if (removeCliToolsetEntries(text.lines, ['mcp-codegraph', 'codegraph'])) removed = true;
    const action = removed ? 'removed' : 'not-found';
    if (removed) atomicWriteFileSync(file, joinText(text));
    return notes.length > 0 ? { files: [{ path: file, action }], notes } : { files: [{ path: file, action }] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Hermes Agent uses $HERMES_HOME/config.yaml; use --location=global.\n';
    }
    return [`# Add to ${configPath()}`, '', 'mcp_servers:', ...renderCodeGraphServer(2), ''].join('\n');
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [configPath()] : [];
  }
}

function hermesHome(): string {
  return process.env.HERMES_HOME
    ? path.resolve(process.env.HERMES_HOME)
    : path.join(os.homedir(), '.hermes');
}

function configPath(): string {
  return path.join(hermesHome(), 'config.yaml');
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function writeHermesConfig(): { file: WriteResult['files'][number]; notes: string[] } {
  const file = configPath();
  const existed = fs.existsSync(file);
  const before = readText(file);
  const text = splitText(before);
  const notes: string[] = [];

  const outcome = upsertCodeGraphServer(text.lines);
  if (outcome === 'blocked') {
    const top = findTop(text.lines, 'mcp_servers')!;
    throw new Error(
      `${file} writes mcp_servers as a one-line mapping (line ${top.line + 1}), so CodeGraph can't add its server without rewriting it. ` +
      'Nothing was changed: add `codegraph: {command: codegraph, args: [serve, --mcp]}` to it yourself, or write mcp_servers as a block, then run this again.',
    );
  }
  if (outcome === 'left-as-written') {
    const server = findCodeGraphServer(text.lines)!;
    notes.push(`Left the mcp_servers.codegraph entry in ${file} (line ${server.line + 1}) as you wrote it: CodeGraph only fills in a block-style entry.`);
  }

  const toolsets = healCliToolsetEntry(text.lines);
  if (toolsets === 'allowlist-without-codegraph') {
    notes.push(`platform_toolsets.cli in ${file} names MCP servers, so CLI sessions load only those. Add \`codegraph\` to that list to use CodeGraph there.`);
  }

  // Rewrite only what was edited: a file CodeGraph had nothing to change in
  // is left byte-for-byte as it is.
  if (outcome !== 'changed' && toolsets !== 'changed') {
    return { file: { path: file, action: 'unchanged' }, notes };
  }
  atomicWriteFileSync(file, joinText(text));
  return { file: { path: file, action: existed ? 'updated' : 'created' }, notes };
}

// ---------------------------------------------------------------------------
// Line-level YAML: just the shapes Hermes and its users write for these keys.
// ---------------------------------------------------------------------------

function indentOf(line: string): number {
  return /^ */.exec(line)![0].length;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** The value text of a `key: value` remainder with any trailing `# comment` removed. */
function stripComment(rest: string): string {
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(rest[i - 1]!))) {
      return rest.slice(0, i).trim();
    }
  }
  return rest.trim();
}

function unquote(key: string): string {
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
    return key.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) {
    return key.slice(1, -1).replace(/''/g, "'");
  }
  return key;
}

/** `  key: value` → its indent, decoded key and inline value ('' for a block). Not for `- item` lines. */
function parseKeyLine(line: string): { indent: number; key: string; value: string } | null {
  const m = /^( *)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:,[\]{}][^:#]*?|-[^\s:#][^:#]*?)[ \t]*:(?=[ \t]|$)(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1]!.length, key: unquote(m[2]!), value: stripComment(m[3]!) };
}

/** A column-0 key: its line, inline value, and where the next column-0 key starts. */
function findTop(lines: string[], key: string): { line: number; value: string; end: number } | null {
  const start = lines.findIndex((l) => {
    const k = parseKeyLine(l);
    return k !== null && k.indent === 0 && k.key === key;
  });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const k = parseKeyLine(lines[i]!);
    if (k && k.indent === 0) {
      end = i;
      break;
    }
  }
  return { line: start, value: parseKeyLine(lines[start]!)!.value, end };
}

/** One past the last indented, non-blank line of a block: where a new child goes. */
function contentEnd(lines: string[], start: number, end: number): number {
  let last = start;
  for (let i = start + 1; i < end; i++) {
    if ((lines[i] ?? '').trim() !== '' && indentOf(lines[i]!) > 0) last = i;
  }
  return last + 1;
}

interface Child {
  key: string;
  line: number;
  value: string;
  /** One past the child's last line. */
  end: number;
}

/** The keys one level inside the block [start, end), and the indent they use (null when empty). */
function childrenOf(lines: string[], start: number, end: number): { indent: number | null; children: Child[] } {
  const stop = contentEnd(lines, start, end);
  let indent: number | null = null;
  for (let i = start + 1; i < stop; i++) {
    if (!isBlankOrComment(lines[i]!)) {
      indent = indentOf(lines[i]!);
      break;
    }
  }
  const children: Child[] = [];
  if (indent === null || indent === 0) return { indent: null, children };
  for (let i = start + 1; i < stop; i++) {
    const k = parseKeyLine(lines[i]!);
    if (k && k.indent === indent) {
      if (children.length > 0) children[children.length - 1]!.end = i;
      children.push({ key: k.key, line: i, value: k.value, end: stop });
    }
  }
  // A child's range ends at its last indented line, not on blank lines before the next sibling.
  for (const c of children) {
    while (c.end > c.line + 1 && (lines[c.end - 1] ?? '').trim() === '') c.end--;
  }
  return { indent, children };
}

// ---------------------------------------------------------------------------
// mcp_servers.codegraph
// ---------------------------------------------------------------------------

/** The entry CodeGraph writes into a new install, with its key at `indent` spaces. */
function renderCodeGraphServer(indent: number): string[] {
  const a = ' '.repeat(indent);
  const b = ' '.repeat(indent * 2);
  const c = ' '.repeat(indent * 3);
  return [
    `${a}codegraph:`,
    `${b}command: codegraph`,
    `${b}args:`,
    `${c}- serve`,
    `${c}- --mcp`,
    `${b}timeout: 120`,
    `${b}connect_timeout: 60`,
    `${b}enabled: true`,
  ];
}

/**
 * Where `mcp_servers.codegraph` is written, in any form: a block or a
 * one-line value under a block `mcp_servers`, at whatever indent its
 * siblings use and with its key quoted or not; or inside a one-line
 * `mcp_servers: {…}` mapping (`inFlowParent`).
 */
function findCodeGraphServer(lines: string[]): (Child & { inFlowParent: boolean }) | null {
  const top = findTop(lines, 'mcp_servers');
  if (!top) return null;
  if (top.value !== '') {
    const mentions = /(^|[{,\s])["']?codegraph["']?\s*:/.test(top.value.replace(/^\{/, ' '));
    return mentions ? { key: 'codegraph', line: top.line, value: top.value, end: top.line + 1, inFlowParent: true } : null;
  }
  const { children } = childrenOf(lines, top.line, top.end);
  const child = children.find((c) => c.key === 'codegraph');
  return child ? { ...child, inFlowParent: false } : null;
}

/**
 * Add the codegraph server when the file has none. An existing entry is
 * the user's: nothing in it is changed, except that a block-style entry
 * missing `command` or `args` (it can't start without them) gets CodeGraph's.
 */
function upsertCodeGraphServer(lines: string[]): 'changed' | 'unchanged' | 'left-as-written' | 'blocked' {
  const top = findTop(lines, 'mcp_servers');
  if (!top) {
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push('mcp_servers:', ...renderCodeGraphServer(2));
    return 'changed';
  }

  if (top.value !== '') {
    if (findCodeGraphServer(lines)) return 'left-as-written';
    // An empty one-line value (`{}`, `null`, `~`) is rewritten as a block; any
    // other one-line mapping holds the user's servers and is never rewritten.
    if (!/^(\{\s*\}|null|Null|NULL|~)$/.test(top.value)) return 'blocked';
    lines.splice(top.line, 1, 'mcp_servers:', ...renderCodeGraphServer(2));
    return 'changed';
  }

  const { indent, children } = childrenOf(lines, top.line, top.end);
  const existing = children.find((c) => c.key === 'codegraph');
  if (!existing) {
    lines.splice(contentEnd(lines, top.line, top.end), 0, ...renderCodeGraphServer(indent ?? 2));
    return 'changed';
  }
  if (existing.value !== '') return 'unchanged';

  const own = childrenOf(lines, existing.line, existing.end);
  const keyIndent = own.indent ?? (indent ?? 2) * 2;
  const has = (key: string) => own.children.some((c) => c.key === key);
  const missing: string[] = [];
  if (!has('command')) missing.push(`${' '.repeat(keyIndent)}command: codegraph`);
  if (!has('args')) missing.push(`${' '.repeat(keyIndent)}args: [serve, --mcp]`);
  if (missing.length === 0) return 'unchanged';
  lines.splice(contentEnd(lines, existing.line, existing.end), 0, ...missing);
  return 'changed';
}

// ---------------------------------------------------------------------------
// platform_toolsets.cli
// ---------------------------------------------------------------------------

interface CliList {
  /** Each `- item` line of the cli list and its unquoted value. */
  items: Array<{ line: number; value: string }>;
}

/** The block-style `platform_toolsets.cli` list, or null (absent, or written on one line). */
function cliList(lines: string[]): CliList | null {
  const top = findTop(lines, 'platform_toolsets');
  if (!top || top.value !== '') return null;
  const cli = childrenOf(lines, top.line, top.end).children.find((c) => c.key === 'cli');
  if (!cli || cli.value !== '') return null;
  const items: CliList['items'] = [];
  for (let i = cli.line + 1; i < cli.end; i++) {
    const m = /^ *- +(.*)$/.exec(lines[i]!);
    if (m) items.push({ line: i, value: unquote(stripComment(m[1]!)) });
  }
  return { items };
}

/** The names of the servers under a block-style `mcp_servers`. */
function serverNames(lines: string[]): Set<string> {
  const top = findTop(lines, 'mcp_servers');
  if (!top || top.value !== '') return new Set();
  return new Set(childrenOf(lines, top.line, top.end).children.map((c) => c.key));
}

/**
 * Take out the `- mcp-codegraph` line earlier installs appended to
 * `platform_toolsets.cli`. When the list names no other MCP server, the
 * line is removed, so every enabled server loads again. When it names
 * others too — an allowlist the user keeps — it becomes `- codegraph`, the
 * spelling every Hermes version reads as naming the server, so CodeGraph
 * stays in it. Reports an allowlist that doesn't include CodeGraph.
 */
function healCliToolsetEntry(lines: string[]): 'unchanged' | 'changed' | 'allowlist-without-codegraph' {
  const list = cliList(lines);
  if (!list) return 'unchanged';
  const servers = serverNames(lines);
  const names = (value: string) => servers.has(value) ? value
    : value.startsWith('mcp-') && servers.has(value.slice(4)) ? value.slice(4) : null;
  const othersNamed = list.items.some((it) => { const n = names(it.value); return n !== null && n !== 'codegraph'; });
  const ours = list.items.filter((it) => it.value === 'mcp-codegraph');
  const bare = list.items.some((it) => it.value === 'codegraph');

  if (ours.length === 0) return othersNamed && !bare ? 'allowlist-without-codegraph' : 'unchanged';
  const [keep, ...drop] = ours;
  for (const it of [...drop].reverse()) lines.splice(it.line, 1);
  if (othersNamed && !bare) lines[keep!.line] = lines[keep!.line]!.replace(/- +.*$/, '- codegraph');
  else lines.splice(keep!.line, 1);
  return 'changed';
}

/** Remove `- <name>` lines for any of `values` from `platform_toolsets.cli`; true when one was. */
function removeCliToolsetEntries(lines: string[], values: string[]): boolean {
  const list = cliList(lines);
  if (!list) return false;
  let removed = false;
  for (const it of [...list.items].reverse()) {
    if (values.includes(it.value)) {
      lines.splice(it.line, 1);
      removed = true;
    }
  }
  return removed;
}

export const hermesTarget: AgentTarget = new HermesTarget();
