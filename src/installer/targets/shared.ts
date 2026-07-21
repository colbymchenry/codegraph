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
 * Unparseable files are backed up to `<path>.backup` BEFORE we return
 * `{}` — so an idempotent re-run never silently deletes a user's
 * existing config that happened to break JSON parse temporarily.
 */
export function readJsonFile(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Could not parse ${path.basename(filePath)}: ${msg}`);
    console.warn(`  A backup will be created before overwriting.`);
    try {
      fs.copyFileSync(filePath, filePath + '.backup');
    } catch { /* ignore backup failure */ }
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
 * Atomic JSON write. Trailing newline matches the convention every
 * existing target had — preserves diff-friendly file shape.
 */
export function writeJsonFile(filePath: string, data: Record<string, any>): void {
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

/**
 * Replace or append a marker-delimited section in a markdown-ish file.
 *
 * Used by Claude / Codex for the `<!-- CODEGRAPH_START --> ... <!--
 * CODEGRAPH_END -->` block. Preserves all content outside the
 * markers verbatim.
 *
 * Returns `created` when the file didn't exist; `updated` when
 * markers were found and content swapped; `appended` when markers
 * weren't found and section was added at end. `unchanged` when the
 * existing block already matches `body`.
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
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx !== -1 && endIdx > startIdx) {
    const existingBlock = content.substring(startIdx, endIdx + endMarker.length);
    if (existingBlock === body) {
      return 'unchanged';
    }
    const before = content.substring(0, startIdx);
    const after = content.substring(endIdx + endMarker.length);
    atomicWriteFileSync(filePath, before + body + after);
    return 'updated';
  }

  // No markers — append. Preserve existing content with a separating
  // blank line.
  const trimmed = content.trimEnd();
  const sep = trimmed.length > 0 ? '\n\n' : '';
  atomicWriteFileSync(filePath, trimmed + sep + body + '\n');
  return 'appended';
}

/**
 * Upsert the CodeGraph instructions block into an agent instructions
 * file (CLAUDE.md / AGENTS.md / GEMINI.md). The one write shared by
 * every target: self-heals a stale pre-#529 long block (markers match →
 * replaced by the current short one), appends after existing user
 * content otherwise, and reports `unchanged` on byte-equal re-runs so
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

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx <= startIdx) return 'not-found';

  const before = content.substring(0, startIdx).trimEnd();
  const after = content.substring(endIdx + endMarker.length).trimStart();
  const joined = before + (before && after ? '\n\n' : '') + after;

  if (joined.trim() === '') {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  } else {
    atomicWriteFileSync(filePath, joined.trim() + '\n');
  }
  return 'removed';
}
