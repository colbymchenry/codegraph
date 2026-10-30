/**
 * DeepSeek Harness (`dsh`) target, global only.
 *
 * dsh has no `mcpServers` file: an MCP server is one row for the
 * `@deepseek-ai/dsh-mcp-client` plugin in a Cordis patch file. We add one to
 * `$DSH_HOME/cordis.patch.yml` (default `~/.dsh`), the home-level layer that
 * applies to every profile, as a `- insert:` patch of its own:
 *
 *   - insert:
 *       - id: mcp-codegraph
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config: { serverName: codegraph, transport: stdio, command, args }
 *
 * and the instructions block to `$DSH_HOME/AGENTS.md`, the start of dsh's
 * user-global instruction chain. `autoAllow` is a no-op.
 *
 * The patch file is the user's, so it is edited as text, line by line, and
 * comments and other patches survive. dsh parses it with js-yaml and refuses to
 * start unless it is a top-level array, so a comments-only file is as fatal as a
 * broken one: install repairs one by adding the patch, and an uninstall that
 * would leave one writes the documented empty list, `[]`.
 *
 * A server is identified by `serverName: codegraph`: two rows with one name in
 * the same scope make the later one fail to load. An entry already there, in
 * this file or a profile's own `cordis.patch.yml`, is the user's. It may pin a
 * `cwd` or a `command`, so install never rewrites it and never adds a second
 * one; uninstall takes it out wherever it can be edited.
 *
 * Docs: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md
 *       https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md
 *       https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import {
  atomicWriteFileSync,
  configDirFromEnv,
  getMcpServerConfig,
  joinText,
  removeFileUnlessLinked,
  removeInstructionsEntry,
  splitText,
  upsertInstructionsEntry,
} from './shared';

type FileResult = WriteResult['files'][number];

/** A span of lines: `start` up to, not including, `end`. */
interface Range {
  start: number;
  end: number;
}

const PATCH_FILE = 'cordis.patch.yml';

/** `serverName: codegraph` in a block or a one-line `{ … }`, quoted or not. */
const NAMES_SERVER = /(^|[\s{,])["']?serverName["']?\s*:\s*["']?codegraph["']?\s*([,}#]|$)/;
const NAMES_CLIENT = /(^|[\s{,])["']?name["']?\s*:\s*["']?@deepseek-ai\/dsh-mcp-client["']?/;

function dshHome(): string {
  return configDirFromEnv('DSH_HOME', path.join(os.homedir(), '.dsh'));
}

function homePatchPath(): string {
  return path.join(dshHome(), PATCH_FILE);
}

function instructionsPath(): string {
  return path.join(dshHome(), 'AGENTS.md');
}

function profilePatchPaths(): string[] {
  const profiles = path.join(dshHome(), 'profiles');
  let names: string[];
  try {
    names = fs.readdirSync(profiles);
  } catch {
    return [];
  }
  return names.map((name) => path.join(profiles, name, PATCH_FILE)).filter((file) => fs.existsSync(file));
}

function readLines(file: string): ReturnType<typeof splitText> {
  try {
    return splitText(fs.readFileSync(file, 'utf-8'));
  } catch {
    return splitText('');
  }
}

function renderEntry(): string[] {
  const { command, args } = getMcpServerConfig();
  return [
    '- insert:',
    '    - id: mcp-codegraph',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: codegraph',
    '        transport: stdio',
    `        command: ${command}`,
    '        args:',
    ...args.map((arg) => `          - ${arg}`),
  ];
}

// ---------------------------------------------------------------------------
// Line-level YAML: a top-level block list and the rows of its `- insert:` items.
// ---------------------------------------------------------------------------

function indentOf(line: string): number {
  return /^ */.exec(line)![0].length;
}

/** A line that holds no value: blank, a comment, or the `---` that opens a document. */
function isTrivia(line: string): boolean {
  const t = line.trim();
  return t === '' || t === '---' || t.startsWith('#');
}

function isTopLevelItem(line: string): boolean {
  return /^-(\s|$)/.test(line);
}

/** Where a span ends, before the blank and comment lines leading up to what follows it. */
function trimmedEnd(lines: string[], start: number, end: number): number {
  while (end > start + 1 && isTrivia(lines[end - 1]!)) end--;
  return end;
}

function topLevelItems(lines: string[]): Range[] {
  const starts = lines.flatMap((line, i) => (isTopLevelItem(line) ? [i] : []));
  return starts.map((start, n) => ({ start, end: trimmedEnd(lines, start, starts[n + 1] ?? lines.length) }));
}

/** The rows of a `- insert:` item: its list items, at the indent of the first. */
function insertRows(lines: string[], item: Range): Range[] {
  if (!/^-\s+insert\s*:\s*(#.*)?$/.test(lines[item.start]!)) return [];
  const body = lines.slice(item.start + 1, item.end);
  const firstAt = body.findIndex((line) => !isTrivia(line));
  if (firstAt === -1 || !/^ +-(\s|$)/.test(body[firstAt]!)) return [];

  const indent = indentOf(body[firstAt]!);
  const starts: number[] = [];
  let stop = item.end;
  for (let i = item.start + 1 + firstAt; i < item.end; i++) {
    const line = lines[i]!;
    if (isTrivia(line)) continue;
    const at = indentOf(line);
    if (at < indent) {
      stop = i;
      break;
    }
    if (at === indent) starts.push(i);
  }
  return starts.map((start, n) => ({ start, end: trimmedEnd(lines, start, starts[n + 1] ?? stop) }));
}

/** Whether a row is CodeGraph's server, by its own `name:`, not one nested in a group's `config`. */
function isCodeGraphRow(lines: string[], row: Range): boolean {
  const body = lines.slice(row.start, row.end).filter((line) => !isTrivia(line));
  if (!body.some((line) => NAMES_SERVER.test(line))) return false;
  const keyIndent = indentOf(body[0]!.replace('-', ' '));
  return body.some((line, i) => (i === 0 || indentOf(line) === keyIndent) && NAMES_CLIENT.test(line));
}

function hasServer(lines: string[]): boolean {
  return lines.some((line) => !isTrivia(line) && NAMES_SERVER.test(line));
}

/**
 * What the file holds, ignoring comments. `empty` has no patches yet, with
 * `emptyList` the line of a `[]` if there is one. Anything but a block list at
 * column 0 (a flow `[…]`, a mapping) is `other`: this editor doesn't change it.
 */
function layoutOf(lines: string[]): { kind: 'list' | 'other' } | { kind: 'empty'; emptyList: number } {
  const content = lines.flatMap((line, i) => (isTrivia(line) ? [] : [i]));
  const first = content[0];
  if (first === undefined) return { kind: 'empty', emptyList: -1 };
  if (content.length === 1 && /^\[\s*\]\s*(#.*)?$/.test(lines[first]!)) return { kind: 'empty', emptyList: first };
  const allItems = content.every((i) => /^\s/.test(lines[i]!) || isTopLevelItem(lines[i]!));
  return { kind: isTopLevelItem(lines[first]!) && allItems ? 'list' : 'other' };
}

/**
 * Take CodeGraph's rows out of `lines`. A `- insert:` holding nothing else goes
 * with them, and the blank line above it. True when anything was removed.
 */
function removeRows(lines: string[]): boolean {
  let removed = false;
  for (const item of topLevelItems(lines).reverse()) {
    const rows = insertRows(lines, item);
    const ours = rows.filter((row) => isCodeGraphRow(lines, row));
    if (ours.length === 0) continue;
    if (ours.length < rows.length) {
      for (const row of [...ours].reverse()) lines.splice(row.start, row.end - row.start);
    } else if (ours[ours.length - 1]!.end === item.end) {
      const start = item.start > 0 && lines[item.start - 1]!.trim() === '' ? item.start - 1 : item.start;
      lines.splice(start, item.end - start);
    } else {
      continue;
    }
    removed = true;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The patch files
// ---------------------------------------------------------------------------

function writePatch(): { file: FileResult; note?: string } {
  const file = homePatchPath();
  const existed = fs.existsSync(file);
  const text = readLines(file);
  if (hasServer(text.lines)) return { file: { path: file, action: 'unchanged' } };

  const profile = profilePatchPaths().find((p) => hasServer(readLines(p).lines));
  if (profile) {
    return {
      file: { path: file, action: 'unchanged' },
      note: `Left the CodeGraph entry in ${profile} as you wrote it: a second one in ${file} would fail to load. Move it there to use CodeGraph in every profile.`,
    };
  }

  const layout = layoutOf(text.lines);
  if (layout.kind === 'other') {
    throw new Error(
      `${file} is not a block-style YAML list, so CodeGraph can't add its server. ` +
      'Nothing was changed: add the entry from `codegraph install --print-config dsh` yourself, then run this again.',
    );
  }
  if (layout.kind === 'empty' && layout.emptyList !== -1) {
    text.lines.splice(layout.emptyList, 1, ...renderEntry());
  } else {
    const separate = layout.kind === 'list';
    while (text.lines.length > 0 && text.lines[text.lines.length - 1]!.trim() === '') text.lines.pop();
    text.lines.push(...(separate ? [''] : []), ...renderEntry());
  }
  atomicWriteFileSync(file, joinText(text));
  return { file: { path: file, action: existed ? 'updated' : 'created' } };
}

/**
 * Take CodeGraph's server out of a patch file. One left with nothing in it is
 * deleted when `mayDelete` (dsh runs without a home-level file, and creates each
 * profile's own), or emptied through a symbolic link. With comments left, it
 * becomes the empty list, because a comments-only file stops dsh from starting.
 */
function removeFromPatch(file: string, mayDelete: boolean): { file: FileResult; note?: string } {
  const text = readLines(file);
  if (!hasServer(text.lines)) return { file: { path: file, action: 'not-found' } };

  const removed = removeRows(text.lines);
  const note = hasServer(text.lines)
    ? `${file} sets CodeGraph's server in a form CodeGraph can't edit safely. Remove it from there yourself.`
    : undefined;
  if (!removed) return { file: { path: file, action: 'not-found' }, note };

  if (layoutOf(text.lines).kind === 'empty') {
    if (mayDelete && text.lines.every((line) => line.trim() === '')) {
      removeFileUnlessLinked(file, `[]${text.eol}`);
      return { file: { path: file, action: 'removed' }, note };
    }
    text.lines.push('[]');
  }
  atomicWriteFileSync(file, joinText(text));
  return { file: { path: file, action: 'removed' }, note };
}

class DshTarget implements AgentTarget {
  readonly id = 'dsh' as const;
  readonly displayName = 'DeepSeek Harness';
  readonly docsUrl = 'https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') return { installed: false, alreadyConfigured: false };
    const file = homePatchPath();
    return {
      installed: fs.existsSync(dshHome()),
      alreadyConfigured: [file, ...profilePatchPaths()].some((p) => hasServer(readLines(p).lines)),
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return { files: [], notes: ['DeepSeek Harness keeps its config in $DSH_HOME; re-run with --location=global.'] };
    }
    const patch = writePatch();
    const notes = ['Start a new dsh session to pick up the MCP server, after a restart if dsh-hmr is off.'];
    if (patch.note) notes.unshift(patch.note);
    return { files: [patch.file, upsertInstructionsEntry(instructionsPath())], notes };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const profiles = profilePatchPaths().map((file) => removeFromPatch(file, false));
    const results = [removeFromPatch(homePatchPath(), true), ...profiles.filter((r) => r.file.action === 'removed' || r.note)];
    const notes = results.flatMap((r) => (r.note ? [r.note] : []));
    const files = [...results.map((r) => r.file), removeInstructionsEntry(instructionsPath())];
    return notes.length > 0 ? { files, notes } : { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') return '# DeepSeek Harness keeps its config in $DSH_HOME; use --location=global.\n';
    return [`# Add to ${homePatchPath()}`, '', ...renderEntry(), ''].join('\n');
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [homePatchPath(), instructionsPath()] : [];
  }
}

export const dshTarget: AgentTarget = new DshTarget();
