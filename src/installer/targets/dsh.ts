/**
 * DeepSeek Harness (dsh) target.
 *
 * DSH keeps all of its state under `$DSH_HOME` (default `~/.dsh`,
 * overridable via a non-empty `DSH_HOME` env var) — there is no
 * project-local config, so this target is global-only like Codex and
 * Hermes. MCP servers are NOT `mcpServers` JSON: they are Cordis plugin
 * rows using `@deepseek-ai/dsh-mcp-client`, declared in the harness's
 * layered patch files. The user-owned layer that applies to EVERY dsh
 * profile (web, headless, custom) is the home-level patch file:
 *
 *   $DSH_HOME/cordis.patch.yml
 *
 * One write there configures codegraph for every profile at once, and a
 * running dsh watches the file and recomposes live (HMR), so the change
 * is picked up without restarting the session.
 *
 * We append one root insert patch (an insert without `id` appends its
 * entries to the composed root entry list — see
 * `@deepseek-ai/cordis-plugin-include`'s `applyEntryPatches`):
 *
 *   - insert:
 *       - id: mcp-codegraph
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config:
 *           serverName: codegraph
 *           transport: stdio
 *           command: codegraph
 *           args:
 *             - serve
 *             - --mcp
 *           failOnStartupError: false
 *
 * The model sees the server's tools as `mcp__codegraph__*` — the same
 * server-qualified naming Claude Code and Codex use, so the existing
 * `mcp__codegraph__*` permission convention applies unchanged.
 * `failOnStartupError: false` pins the dsh-mcp-client default so a
 * missing/unlaunchable codegraph binary never blocks the harness from
 * booting.
 *
 * dsh requires the file to be a valid top-level YAML array: a missing
 * file is fine, but a comments-only file fails to boot (it parses to
 * nothing, not to a list) and `[]` is the documented empty state. This
 * editor keeps the file structurally valid through every operation —
 * and when appending into an existing `- insert:` block it MATCHES the
 * indent of that block's items (js-yaml, which dsh uses to parse the
 * file, rejects block sequences with mixed item indents, and a parse
 * failure aborts the dsh boot):
 *
 *   - install replaces a lone `[]` line with our entry (comments around
 *     it preserved), appends below the comments of a comments-only file
 *     — repairing a currently-unbootable file — appends into the last
 *     `- insert:` block at the matched item indent, or appends a fresh
 *     block after sibling patches;
 *   - a pre-existing codegraph entry that already matches the canonical
 *     rendering at its own indent is left byte-identical (`unchanged`);
 *     one that differs is rewritten in place — at its own indent when
 *     nested in a user's block — so a valid 2-space style file is never
 *     rewritten into a mixed-indent one;
 *   - uninstall strips only our entry when siblings remain, restores
 *     `[]` when only user comments remain, and deletes the file when we
 *     created it and nothing else is left;
 *   - flow-style YAML is handled conservatively: a hand-written
 *     flow-style codegraph entry (a `- { id: mcp-codegraph, ... }` list
 *     item inside a block) IS recognized as configured, but since the
 *     line editor cannot rewrite flow style it is left byte-identical —
 *     install and uninstall report `kept` with a note (appending a
 *     block-style duplicate would double-mount the serverName), and
 *     such an entry in a per-profile patch blocks the install entirely
 *     (migrating it is impossible, and writing the home-level entry
 *     anyway would mount the same serverName twice across layers);
 *   - other files this line editor cannot classify (flow-style arrays,
 *     block mappings, document markers) are left untouched with a note
 *     pointing at `codegraph install --print-config dsh`.
 *
 * Self-heal sweep: dsh composes the home-level layer AFTER each
 * profile's own layer, and a duplicate `serverName` across live
 * dsh-mcp-client instances fails the later instance at load. A
 * pre-installer codegraph entry may therefore sit in a per-profile
 * `$DSH_HOME/profiles/<name>/cordis.patch.yml` — install migrates it up
 * to the shared home layer (removing it from the profile), and uninstall
 * removes codegraph from dsh entirely (home + every profile), keeping
 * detect() and uninstall() symmetric even for a profile-only install.
 *
 * No instructions file is written (issue #529): the MCP `initialize`
 * instructions are the single source of truth for agent-facing tool
 * guidance, and dsh's user-global `$DSH_HOME/AGENTS.md` is the user's
 * personal file, left untouched.
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
import { atomicWriteFileSync } from './shared';

/** Stable entry id the installer owns. */
const ENTRY_ID = 'mcp-codegraph';
/** Cordis plugin that bridges external MCP servers into dsh. */
const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client';
/** Patch filename, identical at the home level and inside each profile. */
const PATCH_FILENAME = 'cordis.patch.yml';
/** A root `- insert:` patch header line. */
const INSERT_HEADER_RE = /^- insert:\s*(?:#.*)?$/;

/** Matches `id: mcp-codegraph` at any indent (trimmed) — including the
 * `- id:` list-item spelling our insert entry uses. */
const ID_LINE = /^(?:- )?id:\s*mcp-codegraph\s*$/;
/** Matches the plugin name single- or double-quoted (YAML requires the
 * quoting — `@` is a reserved indicator at the start of a plain scalar). */
const NAME_LINE = /^name:\s*['"]@deepseek-ai\/dsh-mcp-client['"]\s*$/;

/**
 * A single non-comment line carrying our entry in YAML FLOW style —
 * `{ id: mcp-codegraph, name: '@deepseek-ai/dsh-mcp-client', ... }`,
 * typically a `- { ... }` list item a user hand-wrote inside a block.
 * This predicate is DETECTION-ONLY: it makes detect() report the entry
 * as configured and makes install/uninstall refuse with `kept` + a
 * note (the line editor cannot rewrite flow style, and appending or
 * stripping would duplicate or orphan the serverName mount) — but the
 * entry is never treated as strippable by the block-style logic.
 */
function isFlowStyleOurLine(rawLine: string): boolean {
  const line = (rawLine ?? '').trim();
  if (line.startsWith('#')) return false;
  if (!line.includes(MCP_CLIENT_PLUGIN)) return false;
  return /[{,]\s*id:\s*['"]?mcp-codegraph['"]?\s*[,}]/.test(line);
}

/**
 * Comment lines stamped into a patch file this installer creates.
 * Uninstall recognizes "we created this file" by an exact match against
 * them; any other comment belongs to the user and survives.
 */
function renderHeaderComment(): string[] {
  return [
    '# dsh home-level plugin patch layer — applies to every dsh profile.',
    '# CodeGraph MCP server entry below, added by `codegraph install`.',
  ];
}

/**
 * The `mcp-codegraph` insert entry rendered at the given item indent:
 * the `- id:` line at `indent`, keys at +2, config keys at +4, list
 * items at +6 — internally consistent at every indent, which is what
 * keeps js-yaml happy next to user entries at the same item indent.
 */
function renderCodeGraphEntry(indent: string): string[] {
  const key = indent + '  ';
  const cfg = key + '  ';
  const arg = cfg + '  ';
  return [
    `${indent}- id: ${ENTRY_ID}`,
    `${key}name: '${MCP_CLIENT_PLUGIN}'`,
    `${key}config:`,
    `${cfg}serverName: codegraph`,
    `${cfg}transport: stdio`,
    `${cfg}command: codegraph`,
    `${cfg}args:`,
    `${arg}- serve`,
    `${arg}- --mcp`,
    `${cfg}failOnStartupError: false`,
  ];
}

/**
 * A fresh standalone root insert block, in the style dsh itself renders
 * (item at 4 spaces, keys at 6, config at 8, list items at 10).
 */
function renderCodeGraphBlock(): string[] {
  return ['- insert:', ...renderCodeGraphEntry('    ')];
}

type LineRange = { start: number; end: number };

class DshTarget implements AgentTarget {
  readonly id = 'dsh' as const;
  readonly displayName = 'DeepSeek Harness (dsh)';
  readonly docsUrl = 'https://github.com/deepseek-ai/deepseek-harness';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const home = homePatchPath();
    let alreadyConfigured = hasCodeGraphEntry(readText(home));
    // A per-profile entry also counts as configured — install migrates
    // it up to the home-level layer (duplicate serverName collision).
    if (!alreadyConfigured) {
      alreadyConfigured = profilePatchPaths().some((p) =>
        hasCodeGraphEntry(readText(p)),
      );
    }
    return {
      installed: fs.existsSync(dshHome()) || fs.existsSync(home),
      alreadyConfigured,
      configPath: home,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['DeepSeek Harness config lives under $DSH_HOME; re-run with --location=global.'],
      };
    }
    const files: WriteResult['files'] = [];

    // A flow-style codegraph entry in any per-profile patch blocks the
    // install wholesale: migrating it up to the home layer is impossible
    // (the line editor cannot rewrite flow style), and writing the
    // home-level entry anyway would mount serverName `codegraph` twice
    // across the two layers — the later instance fails at load.
    const flowProfile = profilePatchPaths().find((p) =>
      fs.existsSync(p) && splitLines(readText(p)).some(isFlowStyleOurLine));
    if (flowProfile !== undefined) {
      return {
        files: [{ path: homePatchPath(), action: 'kept' }],
        notes: [
          `${flowProfile} carries a CodeGraph entry in YAML flow style, which this installer cannot edit — nothing was written. Rewrite or remove that entry by hand (see \`codegraph install --print-config dsh\` for the block-style form) and re-run.`,
        ],
      };
    }

    const write = writeDshPatch();
    files.push({ path: write.file, action: write.action });
    if (write.note) {
      return { files, notes: [write.note] };
    }

    // Self-heal: migrate any per-profile codegraph entry up to the
    // home-level layer so the same `serverName` never mounts twice.
    files.push(...sweepProfileEntries());

    return {
      files,
      notes: ['DSH applies patch-file changes live (HMR); start a new session if the tools don\'t appear.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];
    files.push(removeDshPatch());
    // Full reversal: sweep any per-profile codegraph entry too, so a
    // profile-only install (which detect() reports as configured) is
    // removed as well.
    files.push(...sweepProfileEntries());
    // A flow-style codegraph entry was detected but refused: say so,
    // rather than silently claiming codegraph was removed.
    if (files.some((f) => f.action === 'kept')) {
      return {
        files,
        notes: [
          'A CodeGraph entry written in YAML flow style was left untouched — this installer edits block-style entries only. Remove it by hand if needed (see `codegraph install --print-config dsh` for the block-style form).',
        ],
      };
    }
    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# DeepSeek Harness config lives under $DSH_HOME; use --location=global.\n';
    }
    return [
      `# Add to ${homePatchPath()} — the dsh home-level patch layer, applied to every dsh profile.`,
      '# A running dsh reloads this file live.',
      '',
      ...renderCodeGraphBlock(),
      '',
    ].join('\n');
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [homePatchPath()] : [];
  }
}

/**
 * The DSH home. Precedence matches `@deepseek-ai/dsh-home-paths`:
 * a non-empty `$DSH_HOME`, else `~/.dsh`.
 */
function dshHome(): string {
  const env = process.env.DSH_HOME;
  return env && env.trim().length > 0
    ? path.resolve(env)
    : path.join(os.homedir(), '.dsh');
}

/** The home-level patch layer, applied over every profile. */
function homePatchPath(): string {
  return path.join(dshHome(), PATCH_FILENAME);
}

/** Every profile's own patch file, for the duplicate-serverName sweep. */
function profilePatchPaths(): string[] {
  const profilesDir = path.join(dshHome(), 'profiles');
  if (!fs.existsSync(profilesDir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(profilesDir, e.name, PATCH_FILENAME));
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** Join lines with a single trailing newline, dropping trailing blanks. */
function joinLines(lines: string[]): string {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.length === 0 ? '' : out.join('\n') + '\n';
}

function stripTrailingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last === undefined || last.trim() !== '') break;
    out.pop();
  }
  return out;
}

function linesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

function isBlankOrComment(line: string | undefined): boolean {
  const trimmed = (line ?? '').trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * Top-level YAML list items: lines starting with `- ` (or a bare `-`)
 * at column 0. Each span runs to the next top-level item or EOF, minus
 * trailing blank / comment lines — those sit *between* items and must
 * survive an item's removal or replacement.
 */
function topLevelItems(lines: string[]): LineRange[] {
  const spans: LineRange[] = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isItemStart = i < lines.length && /^-(?: |$)/.test(lines[i] ?? '');
    if (start !== -1 && (isItemStart || i === lines.length)) {
      let end = i;
      while (end > start + 1 && isBlankOrComment(lines[end - 1])) end--;
      spans.push({ start, end });
      start = -1;
    }
    if (isItemStart) start = i;
  }
  return spans;
}

/**
 * Nested list entries inside a top-level item's span: lines matching
 * `^(\s+)- ` (at least one leading space, so the top-level `- insert:`
 * header itself is not one). Each entry runs to the next line starting
 * a list item at the same or a shallower indent, to a non-comment line
 * dedented below the entry's indent, or to the span end — trailing
 * blank/comment lines excluded so they survive a removal.
 */
function nestedEntrySpans(lines: string[], span: LineRange): Array<LineRange & { indent: string }> {
  const spans: Array<LineRange & { indent: string }> = [];
  let start = -1;
  let indent = '';
  const closeAt = (i: number): void => {
    let end = i;
    while (end > start + 1 && isBlankOrComment(lines[end - 1])) end--;
    spans.push({ start, end, indent });
    start = -1;
  };
  for (let i = span.start + 1; i < span.end; i++) {
    const line = lines[i] ?? '';
    const m = line.match(/^(\s+)- /);
    if (m && m[1] !== undefined) {
      if (start !== -1 && m[1].length <= indent.length) closeAt(i);
      if (start === -1) {
        start = i;
        indent = m[1];
      }
      continue;
    }
    if (start !== -1 && !isBlankOrComment(line)) {
      const lineIndent = line.match(/^( *)/)?.[1] ?? '';
      if (lineIndent.length < indent.length) closeAt(i);
    }
  }
  if (start !== -1) {
    let end = span.end;
    while (end > start + 1 && isBlankOrComment(lines[end - 1])) end--;
    spans.push({ start, end, indent });
  }
  return spans;
}

/**
 * Whether a line range is OUR insert entry: it carries both the
 * `id: mcp-codegraph` and the `name: '@deepseek-ai/dsh-mcp-client'`
 * lines at some indent inside the range. Requiring both keeps a user's
 * id-targeted override patch (`- id: mcp-codegraph` with e.g.
 * `disabled: true`) recognized as a sibling, not as ours.
 */
function isOurEntry(lines: string[], span: LineRange): boolean {
  let hasId = false;
  let hasName = false;
  for (let i = span.start; i < span.end; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (ID_LINE.test(trimmed)) hasId = true;
    if (NAME_LINE.test(trimmed)) hasName = true;
  }
  return hasId && hasName;
}

function hasCodeGraphEntry(content: string): boolean {
  const lines = splitLines(content);
  // Flow-style entries count for detection even though the editor
  // refuses to rewrite them (see isFlowStyleOurLine).
  if (lines.some(isFlowStyleOurLine)) return true;
  return topLevelItems(lines).some((span) => isOurEntry(lines, span));
}

/** Indices of non-blank, non-comment lines. */
function nonCommentLines(lines: string[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankOrComment(lines[i])) idx.push(i);
  }
  return idx;
}

function findEmptyArrayLine(lines: string[]): number {
  return lines.findIndex((line) => (line ?? '').trim() === '[]');
}

/**
 * A top-level line that is neither a list item, nor blank/comment, nor
 * the documented empty state `[]` — a scalar, mapping, flow collection,
 * or document marker. A file carrying one of those is not a shape this
 * editor can classify; touching it risks corrupting an already-unusual
 * (or already-invalid) file. (`[]` mixed with real items is rejected
 * separately, inside `placeCanonicalEntry`.)
 */
function hasForeignTopLevelLine(lines: string[]): boolean {
  return lines.some((line) => {
    const raw = line ?? '';
    if (/^\s/.test(raw)) return false; // nested content, not top-level
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return false;
    if (trimmed === '[]') return false;
    return !/^-(?: |$)/.test(raw);
  });
}

type PatchWrite =
  | { file: string; action: 'created' | 'updated' | 'unchanged' | 'kept'; note?: string };

/**
 * Upsert our insert entry into the home-level patch file. See the module
 * doc comment for the full state matrix.
 */
function writeDshPatch(): PatchWrite {
  const file = homePatchPath();
  const existed = fs.existsSync(file);
  const before = readText(file);

  if (!existed) {
    atomicWriteFileSync(file, joinLines([...renderHeaderComment(), '', ...renderCodeGraphBlock()]));
    return { file, action: 'created' };
  }

  const lines = splitLines(before);

  // A flow-style codegraph entry: recognized as configured, but the
  // line editor cannot rewrite flow style — appending a duplicate
  // block-style entry would double-mount serverName `codegraph`. Refuse
  // with the unsupported note.
  if (lines.some(isFlowStyleOurLine)) {
    return unsupported(file);
  }

  const items = topLevelItems(lines);
  const ours = items.filter((span) => isOurEntry(lines, span));

  // Fast path: exactly one entry of ours whose bytes already match the
  // canonical rendering at its own indent (standalone block or nested
  // among user entries) — a byte-identical no-op.
  if (ours.length === 1) {
    const first = ours[0]!;
    const nested = nestedEntrySpans(lines, first);
    const nestedOurs = nested.filter((s) => isOurEntry(lines, s));
    if (nestedOurs.length === 1) {
      const target = nestedOurs[0]!;
      if (nested.length === 1) {
        const standalone = ['- insert:', ...renderCodeGraphEntry(target.indent)];
        if (linesEqual(lines.slice(first.start, first.end), standalone)) {
          return { file, action: 'unchanged' };
        }
      } else if (linesEqual(lines.slice(target.start, target.end), renderCodeGraphEntry(target.indent))) {
        return { file, action: 'unchanged' };
      }
    }
  }

  // A shape we cannot classify: leave the file alone rather than risk
  // corrupting an already-unusual (or already-invalid) patch file.
  if (hasForeignTopLevelLine(lines)) {
    return unsupported(file);
  }

  // Everything else — absent, hand-modified, duplicated, or misplaced —
  // normalizes through strip-then-place: remove every entry of ours,
  // then place the canonical entry at the file's own style.
  const placed = placeCanonicalEntry(stripOurEntries(lines));
  if (placed === null) return unsupported(file);
  if (placed === before) return { file, action: 'unchanged' };
  atomicWriteFileSync(file, placed);
  return { file, action: 'updated' };
}

/**
 * Place the canonical entry into a patch file that holds none of ours.
 * Returns the new file content, or null when the file's shape is not
 * classifiable. Never mutates the input array.
 */
function placeCanonicalEntry(lines: string[]): string | null {
  const contentIdx = nonCommentLines(lines);
  const items = topLevelItems(lines);
  const emptyArray = findEmptyArrayLine(lines);

  // Comments-only: dsh fails to boot on this (parses to nothing, not a
  // list). Appending our entry below the comments repairs the file.
  if (contentIdx.length === 0) {
    return joinLines([...stripTrailingBlanks(lines), ...renderCodeGraphBlock()]);
  }

  // The documented empty state: comments around a lone `[]`. Replace
  // the `[]` token with our block so the comments stay where the user
  // put them. Anything mixing `[]` with other content is not a shape we
  // can classify.
  if (emptyArray !== -1) {
    if (items.length > 0 || contentIdx.length !== 1) return null;
    const next = [...lines];
    next.splice(emptyArray, 1, ...renderCodeGraphBlock());
    return joinLines(next);
  }

  // Append into the LAST root `- insert:` block that carries entries,
  // at that block's item indent — matching the user's style instead of
  // forcing ours (js-yaml rejects mixed item indents in one sequence).
  for (let i = items.length - 1; i >= 0; i--) {
    const span = items[i]!;
    if (!INSERT_HEADER_RE.test(lines[span.start] ?? '')) continue;
    const nested = nestedEntrySpans(lines, span);
    if (nested.length === 0) continue;
    const last = nested[nested.length - 1]!;
    const next = [...lines];
    next.splice(last.end, 0, ...renderCodeGraphEntry(last.indent));
    return joinLines(next);
  }

  // Sibling patch entries, no insert block: append ours as a new
  // top-level block, separated by one blank line.
  if (items.length > 0) {
    const next = stripTrailingBlanks(lines);
    next.push('', ...renderCodeGraphBlock());
    return joinLines(next);
  }

  // Flow-style arrays, block mappings, document markers, …
  return null;
}

/**
 * Remove every codegraph entry (standalone block, nested entry, or
 * misplaced top-level row) from a patch file's lines. Returns the
 * remaining lines; never mutates the input.
 */
function stripOurEntries(lines: string[]): string[] {
  let current = [...lines];
  // Loop until stable: removing a top-level item shifts the spans of
  // everything after it, so recompute each pass.
  for (;;) {
    const items = topLevelItems(current);
    let removed = false;

    for (const span of items) {
      if (!isOurEntry(current, span)) continue;
      const nested = nestedEntrySpans(current, span);
      const nestedOurs = nested.filter((s) => isOurEntry(current, s));

      if (INSERT_HEADER_RE.test(current[span.start] ?? '') && nested.length === nestedOurs.length) {
        // Standalone block (or an insert header holding only our
        // entries): remove the whole top-level item and one blank
        // separator above it.
        removeTopLevelItem(current, span);
        removed = true;
        break;
      }

      if (nestedOurs.length > 0) {
        // Nested among user entries: remove only our entries, latest
        // first so earlier indices stay valid.
        for (const ours of nestedOurs.reverse()) {
          current.splice(ours.start, ours.end - ours.start);
        }
        removed = true;
        break;
      }

      // Misplaced top-level row carrying our id+name.
      removeTopLevelItem(current, span);
      removed = true;
      break;
    }

    if (!removed) return current;
  }
}

/**
 * Remove one top-level item's span (and, when the line above it is a
 * blank separator, that single blank) from `lines`, in place.
 */
function removeTopLevelItem(lines: string[], span: LineRange): void {
  const start = span.start > 0 && (lines[span.start - 1] ?? '').trim() === ''
    ? span.start - 1
    : span.start;
  lines.splice(start, span.end - start);
}

function unsupported(file: string): PatchWrite {
  return {
    file,
    action: 'kept',
    note: `${file} uses a style this installer cannot edit safely — add the entry from \`codegraph install --print-config dsh\` by hand.`,
  };
}

/**
 * Remove our insert entry from a patch file. Sibling entries always
 * survive; when nothing but comments remains the file is restored to
 * the documented empty state `[]` (a comments-only file aborts the dsh
 * boot). `allowDelete` lets the home-level uninstall remove a file this
 * installer created; per-profile sweep files are never deleted.
 */
function removeCodeGraphFromFile(
  file: string,
  allowDelete: boolean,
): WriteResult['files'][number] {
  if (!fs.existsSync(file)) {
    return { path: file, action: 'not-found' };
  }

  const content = readText(file);
  if (!hasCodeGraphEntry(content)) {
    return { path: file, action: 'not-found' };
  }

  // A flow-style codegraph entry is detected as configured but cannot
  // be stripped safely — never claim removed, never mangle the file.
  if (splitLines(content).some(isFlowStyleOurLine)) {
    return { path: file, action: 'kept' };
  }

  const remaining = stripOurEntries(splitLines(content));

  // Sibling patch entries or other content survive — strip only ours.
  if (topLevelItems(remaining).length > 0 || nonCommentLines(remaining).length > 0) {
    atomicWriteFileSync(file, joinLines(remaining));
    return { path: file, action: 'removed' };
  }

  // Only comments remain (or nothing at all). If they are exactly — and
  // only — the header we stamp, we created this file: delete it for a
  // clean round-trip. Otherwise the comments are the user's: keep them
  // and restore `[]` so the file stays a valid (empty) patch list.
  const nonBlank = remaining.filter((line) => line.trim() !== '');
  const header = renderHeaderComment();
  if (allowDelete && nonBlank.length === header.length && linesEqual(nonBlank, header)) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    return { path: file, action: 'removed' };
  }
  atomicWriteFileSync(file, joinLines([...stripTrailingBlanks(remaining), '[]']));
  return { path: file, action: 'removed' };
}

function removeDshPatch(): WriteResult['files'][number] {
  return removeCodeGraphFromFile(homePatchPath(), true);
}

/**
 * Strip a codegraph entry from every per-profile `cordis.patch.yml`
 * (the home-level layer composes after each profile's own layer, so a
 * leftover same-`serverName` entry there would collide). Profile files
 * are never deleted — the installer does not create them. Returns only
 * files actually changed, keeping install output quiet when there is
 * nothing to heal.
 */
function sweepProfileEntries(): WriteResult['files'] {
  const out: WriteResult['files'] = [];
  for (const file of profilePatchPaths()) {
    if (!fs.existsSync(file)) continue;
    if (!hasCodeGraphEntry(readText(file))) continue;
    out.push(removeCodeGraphFromFile(file, false));
  }
  return out;
}

export const dshTarget: AgentTarget = new DshTarget();
