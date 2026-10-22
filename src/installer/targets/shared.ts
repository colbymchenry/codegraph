/**
 * Helpers shared across `AgentTarget` implementations.
 *
 * Lifted from the original `config-writer.ts` so each target can
 * compose them without inheritance. Kept deliberately small — the
 * targets are different enough (JSON vs TOML vs Markdown, varying
 * idempotency markers) that a base class would force the awkward
 * shape onto everyone.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CODEGRAPH_INSTRUCTIONS_BLOCK,
  CODEGRAPH_SECTION_START,
  CODEGRAPH_SECTION_END,
} from '../instructions-template';

/**
 * The MCP-server config block codegraph injects. Same shape across
 * all JSON-shaped agent configs (Claude, Cursor, opencode), only the
 * surrounding wrapper differs. Codex (TOML) builds its own block.
 */
export function getMcpServerConfig(): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

/**
 * Permissions list for Claude `settings.json`. Other targets that
 * have a permissions concept can compose this list directly.
 *
 * One server-scoped wildcard rather than a per-tool list. By default only
 * `codegraph_explore` is even LISTED to the agent (see DEFAULT_MCP_TOOLS in
 * mcp/tools.ts), so in practice explore is the only tool this auto-approves —
 * but the wildcard means that if a user re-enables another tool via
 * CODEGRAPH_MCP_TOOLS, it's already pre-approved (no permission prompt, no
 * hand-editing settings.json), and future tools are covered too. Claude only
 * honors globs after a literal `mcp__<server>__` prefix, so this exact string
 * is the way to allow-all for one server; a bare `mcp__codegraph` or `*` is
 * ignored. The allowlist gates PROMPTING, not visibility, so a superset here
 * never makes a hidden tool appear.
 */
export function getCodeGraphPermissions(): string[] {
  return ['mcp__codegraph__*'];
}

/**
 * Read a JSON file, returning `{}` when missing or unparseable.
 *
 * Read-only, and deliberately silent: every target's `detect()` reads
 * its agent's config on every `codegraph install`, and most of those
 * agents codegraph was never installed into. A warning about a file we
 * are not going to touch is noise, and a `<path>.backup` beside it is a
 * bug — `install --refresh` promises unconfigured agents are "skipped
 * untouched", and an empty `~/.gemini/config/mcp_config.json` was
 * getting backed up by the detection pass alone (issue #1870).
 *
 * Preserving an unparseable config is `writeJsonFile`'s job — it runs
 * only where one is actually about to be overwritten.
 */
export function readJsonFile(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write a file atomically: write to `<path>.tmp.<pid>`, then rename.
 *
 * Prevents corruption if the process crashes mid-write. The temp
 * file is cleaned up on rename failure.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Copy a file we're about to overwrite to `<path>.backup` when it isn't
 * parseable JSON — `readJsonFile` handed the caller `{}` for it, so the
 * write is a replacement, not an edit, and without this the user's
 * config would be gone. No-op when the file is absent or parses fine.
 */
function backupUnparseableJson(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  try {
    JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Could not parse ${path.basename(filePath)}: ${msg}`);
    console.warn(`  A backup will be created before overwriting.`);
  }
  try {
    fs.copyFileSync(filePath, filePath + '.backup');
  } catch { /* ignore backup failure */ }
}

/**
 * Atomic JSON write. Trailing newline matches the convention every
 * existing target had — preserves diff-friendly file shape.
 *
 * The single point where a target replaces a JSON config, so it is also
 * where an unparseable one gets preserved (issue #1870) — reading a
 * config no longer has that side effect.
 */
export function writeJsonFile(filePath: string, data: Record<string, any>): void {
  backupUnparseableJson(filePath);
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Compare two JSON values for deep equality, ignoring key order.
 *
 * Used for idempotency: when the on-disk config already exactly
 * matches what we'd write, return action=`unchanged` instead of
 * re-writing (and emitting a confusing "Updated" log line).
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => jsonDeepEqual(ao[k], bo[k]));
}

/** One marker-delimited block: `start` is the start marker's offset, `end` is just past the end marker. */
interface MarkedSection {
  start: number;
  end: number;
}

/**
 * True when the marker at `at` is alone on its line: only spaces or tabs
 * around it (plus a file-leading BOM, or the `\r` of a CRLF). Every block
 * codegraph has ever written puts its markers on lines of their own, so a
 * marker the user quotes inside a sentence is their text, not a block edge.
 */
function markerOnOwnLine(content: string, at: number, length: number): boolean {
  for (let i = at - 1; i >= 0 && content[i] !== '\n'; i--) {
    if (content[i] !== ' ' && content[i] !== '\t' && content[i] !== '\uFEFF') return false;
  }
  for (let i = at + length; i < content.length && content[i] !== '\n'; i++) {
    if (content[i] !== ' ' && content[i] !== '\t' && content[i] !== '\r') return false;
  }
  return true;
}

/**
 * Every well-formed marker block in `content`, in file order. Each end
 * marker closes the nearest start marker before it, so a block never
 * contains another start marker. A start marker left without its end (half
 * of a block deleted by hand) and an end marker without its start are plain
 * text — neither can stretch a block over the user's own content.
 *
 * Issue #2506: the first start marker was paired with the first end marker
 * anywhere in the file, so one stray start marker above the real block made
 * an upgrade's refresh replace everything between them — the whole file,
 * when the stray marker was its first line.
 */
function findMarkedSections(content: string, startMarker: string, endMarker: string): MarkedSection[] {
  const marks: Array<{ at: number; isStart: boolean }> = [];
  for (const [marker, isStart] of [[startMarker, true], [endMarker, false]] as const) {
    for (let at = content.indexOf(marker); at !== -1; at = content.indexOf(marker, at + marker.length)) {
      if (markerOnOwnLine(content, at, marker.length)) marks.push({ at, isStart });
    }
  }
  marks.sort((a, b) => a.at - b.at);

  const sections: MarkedSection[] = [];
  let open = -1;
  for (const mark of marks) {
    if (mark.isStart) {
      open = mark.at;
    } else if (open !== -1) {
      sections.push({ start: open, end: mark.at + endMarker.length });
      open = -1;
    }
  }
  return sections;
}

/** The line break `text` uses (its first one); `\n` when it has none. */
function lineBreakOf(text: string): '\n' | '\r\n' {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

function withLineBreaks(text: string, eol: string): string {
  return text.replace(/\r?\n/g, eol);
}

/** True when `text` holds nothing but whitespace (and a BOM). */
function isBlank(text: string): boolean {
  return text.replace(/^\uFEFF/, '').trim() === '';
}

/**
 * `content` without the given blocks. Only the whitespace touching a removed
 * block changes: the text on either side is rejoined with one blank line, or
 * with nothing at the start or end of the file.
 */
function dropMarkedSections(content: string, sections: readonly MarkedSection[], eol: string): string {
  let out = content.slice(0, sections[0]!.start);
  for (let i = 0; i < sections.length; i++) {
    const nextStart = i + 1 < sections.length ? sections[i + 1]!.start : content.length;
    const left = out.replace(/[ \t\r\n]+$/, '');
    const right = content.slice(sections[i]!.end, nextStart).replace(/^[ \t\r\n]+/, '');
    if (right === '') out = isBlank(left) ? left : left + eol;
    else if (isBlank(left)) out = left + right;
    else out = left + eol + eol + right;
  }
  return out;
}

/**
 * Replace or append a marker-delimited section in a markdown-ish file.
 *
 * Used for the `<!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->` block
 * every target writes into its instructions file. Only the bytes between the
 * first block's markers change: everything outside them — the user's text,
 * their line endings, a missing final newline, a BOM, a stray marker — is
 * kept byte-for-byte. The block is written with the line breaks it already
 * had, so a CRLF file stays CRLF. Further blocks (duplicates) are removed,
 * keeping the text around them. With no block yet, the section is appended
 * after the existing bytes, which are left exactly as they were.
 *
 * Returns `created` when the file didn't exist; `updated` when a block was
 * found and rewritten; `appended` when none was found and the section was
 * added at the end; `unchanged` when the file already holds exactly one
 * block matching `body`.
 */
export function replaceOrAppendMarkedSection(
  filePath: string,
  body: string,
  startMarker: string,
  endMarker: string,
): 'created' | 'updated' | 'appended' | 'unchanged' {
  if (!fs.existsSync(filePath)) {
    atomicWriteFileSync(filePath, body + '\n');
    return 'created';
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const sections = findMarkedSections(content, startMarker, endMarker);

  if (sections.length > 0) {
    const [first, ...duplicates] = sections;
    const block = withLineBreaks(body, lineBreakOf(content.slice(first!.start, first!.end)));
    let next = content.slice(0, first!.start) + block + content.slice(first!.end);
    if (duplicates.length > 0) {
      const shift = block.length - (first!.end - first!.start);
      next = dropMarkedSections(
        next,
        duplicates.map((s) => ({ start: s.start + shift, end: s.end + shift })),
        lineBreakOf(content),
      );
    }
    if (next === content) {
      return 'unchanged';
    }
    atomicWriteFileSync(filePath, next);
    return 'updated';
  }

  // No block yet — append one, separated by a blank line. Nothing already in
  // the file is trimmed or rewritten; only line breaks are added, in the
  // file's own style.
  const eol = lineBreakOf(content);
  const block = withLineBreaks(body, eol);
  if (isBlank(content)) {
    atomicWriteFileSync(filePath, (content.startsWith('\uFEFF') ? '\uFEFF' : '') + block + eol);
    return 'appended';
  }
  const sep = /\n[ \t]*\r?\n[ \t\r]*$/.test(content) ? '' : /\n[ \t\r]*$/.test(content) ? eol : eol + eol;
  atomicWriteFileSync(filePath, content + sep + block + eol);
  return 'appended';
}

/**
 * Upsert the CodeGraph instructions block into an agent instructions
 * file (CLAUDE.md / AGENTS.md / GEMINI.md). The one write shared by
 * every target — `install`, and the `install --refresh` that
 * `codegraph upgrade` runs: self-heals a stale pre-#529 long block
 * (markers match → replaced by the current short one), appends after
 * existing user content otherwise, never changes a byte outside the
 * block (#2506), and reports `unchanged` on byte-equal re-runs so
 * install stays idempotent. See `instructions-template.ts` for why this
 * block exists (#704: subagents + non-MCP harnesses never see the MCP
 * initialize instructions).
 */
export function upsertInstructionsEntry(file: string): { path: string; action: 'created' | 'updated' | 'unchanged' } {
  const action = replaceOrAppendMarkedSection(
    file,
    CODEGRAPH_INSTRUCTIONS_BLOCK,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  return { path: file, action: action === 'appended' ? 'updated' : action };
}

/**
 * `content` with every well-formed marker block removed, or `null` when it
 * has none. A stray start or end marker is left alone (see
 * `findMarkedSections`), and only the whitespace touching a removed block
 * changes. Shared by `removeMarkedSection` and the Cursor rules-file cleanup.
 */
export function stripMarkedSections(content: string, startMarker: string, endMarker: string): string | null {
  const sections = findMarkedSections(content, startMarker, endMarker);
  return sections.length === 0 ? null : dropMarkedSections(content, sections, lineBreakOf(content));
}

/**
 * Inverse of `replaceOrAppendMarkedSection`. Strips the marker
 * block from `filePath` if present. If the file becomes empty after
 * removal, deletes the file entirely (matches the existing Claude
 * uninstall behavior).
 *
 * Returns `removed` when content was stripped, `not-found` when
 * the markers weren't present, `kept` when the file didn't exist.
 */
export function removeMarkedSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
): 'removed' | 'not-found' | 'kept' {
  if (!fs.existsSync(filePath)) return 'kept';

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 'kept';
  }

  const rest = stripMarkedSections(content, startMarker, endMarker);
  if (rest === null) return 'not-found';

  if (isBlank(rest)) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  } else {
    atomicWriteFileSync(filePath, rest);
  }
  return 'removed';
}
