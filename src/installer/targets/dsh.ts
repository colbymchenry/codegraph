/**
 * DeepSeek Harness (dsh) target.
 *
 * The DeepSeek Harness keeps ALL of its state under `$DSH_HOME` (default
 * `~/.dsh`, overridable via the `DSH_HOME` env var) — there is no
 * project-local config, so this target is global-only like Codex /
 * Hermes. Within the home there are two user-editable patch layers:
 *
 *   - `$DSH_HOME/cordis.patch.yml`            — the HOME-level layer, applied
 *     over EVERY profile's own layer (web, headless, custom, ...). This is
 *     the single, machine-wide place to put an MCP server.
 *   - `$DSH_HOME/profiles/<name>/cordis.patch.yml` — one layer PER profile.
 *
 * We write to the home-level file: one write configures codegraph for every
 * DSH profile, and the boot watches that file live (`watchUserPatches`), so
 * the dsh-mcp-client plugin hot-swaps the server via HMR without a restart.
 *
 * The MCP server is a Cordis plugin entry inserted through the patch
 * file's `- insert:` root form:
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
 * (dsh-mcp-client schema: `serverName` namespaces the tools as
 * `mcp__codegraph__*`; `failOnStartupError: false` keeps the UI booting
 * even if the server can't start.)
 *
 * Self-heal: a pre-installer user may have put a codegraph entry in a
 * per-profile `cordis.patch.yml` (as was done by hand before this target
 * existed). Because the home-level layer composes AFTER a profile's layer,
 * a same-`serverName` entry left in a profile would collide with the
 * home-level one — dsh-mcp-client fails the later duplicate at load. So
 * install AND uninstall both sweep codegraph entries out of every profile
 * patch, exactly like opencode's legacy-%APPDATA% cleanup: install migrates
 * the entry up to the shared layer, and uninstall removes codegraph from the
 * agent entirely (home + any profile), keeping detect() and uninstall()
 * symmetric even for a profile-only install.
 *
 * Project root: DSH never sends a workspace root (dsh-mcp-client connects
 * with no roots capability) and never chdir()s to the workspace, so a
 * global `command: codegraph` entry resolves the project from the spawned
 * process's inherited cwd — the harness launch dir, not an indexed project.
 * The agent reaches the graph by passing `projectPath` (which the server's
 * no-root-index guidance points at), or the user can pin `cwd` / `--path`
 * on the entry for a specific project.
 *
 * No instructions file is written. The MCP server's `initialize`
 * instructions are the single source of truth for agent-facing tool
 * guidance (issue #529), so the installer deliberately writes no duplicate
 * block — DSH's own dsh-agent-instructions does read a user-global
 * `$DSH_HOME/AGENTS.md`, but that is the user's personal file and is left
 * untouched (matching the no-duplicate-block policy every target follows).
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
import {
  arrayEqual,
  atomicWriteFileSync,
  escapeRegExp,
  joinLines,
  readTextFile,
  splitLines,
} from './shared';

/** Stable entry id the installer owns, also used as the duplicate marker. */
const ENTRY_ID = 'mcp-codegraph';
/** Cordis plugin that connects to external MCP servers. */
const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client';
/** Per-profile patch filename, same at home level and inside each profile. */
const PATCH_FILENAME = 'cordis.patch.yml';
/** A root `- insert:` patch header (inserts entries into the tree root). */
const INSERT_HEADER_RE = /^- insert:\s*(?:#.*)?$/;

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

/** Every profile's own patch file, if any. */
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

/**
 * The canonical `mcp-codegraph` entry, indented for a root `- insert:`
 * list (entry at 4 spaces, keys at 6, config keys at 8, args at 10 —
 * matching what DSH itself renders).
 */
function renderCodeGraphEntry(): string[] {
  return [
    '    - id: mcp-codegraph',
    `      name: '${MCP_CLIENT_PLUGIN}'`,
    '      config:',
    '        serverName: codegraph',
    '        transport: stdio',
    '        command: codegraph',
    '        args:',
    '          - serve',
    '          - --mcp',
    '        failOnStartupError: false',
  ];
}

/** Index of the first line that is a `- id: <entryId>` list item (any indent). */
function findEntryLine(lines: string[], id: string): number {
  const pattern = new RegExp(`^\\s+- id: ${escapeRegExp(id)}\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] ?? '')) return i;
  }
  return -1;
}

/**
 * `[start, end)` of a list-item entry whose first line is `lines[start]`
 * (a `- id: ...` line at some indent). Runs until the next line that starts
 * a list item at the SAME or a shallower indent (a sibling or a top-level
 * patch), or EOF. Blank lines and comments don't end the entry.
 */
function entryRange(lines: string[], start: number): { start: number; end: number } {
  const indent = (lines[start] ?? '').match(/^( *)- /)?.[1]?.length ?? 0;
  let lastContent = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const m = line.match(/^( *)- /);
    if (m && (m[1]?.length ?? 0) <= indent) {
      // A sibling entry (or top-level patch) at the same/shallower indent
      // ends this one — at the boundary line, trailing blanks excluded.
      return { start, end: i };
    }
    lastContent = i + 1;
  }
  // EOF — end at the last content line so a trailing blank line left by
  // the file's final newline is not counted as part of the entry.
  return { start, end: lastContent };
}

/**
 * Ensure exactly one canonical codegraph entry, inside a root `- insert:`
 * block, preserving every other line of the file. Returns the new content
 * and whether it changed (byte-compare used by the caller for idempotency).
 */
function upsertCodeGraphEntry(content: string): { content: string; changed: boolean } {
  const lines = splitLines(content);
  const canonical = renderCodeGraphEntry();
  const existing = findEntryLine(lines, ENTRY_ID);

  if (existing !== -1) {
    const range = entryRange(lines, existing);
    const current = lines.slice(range.start, range.end);
    if (arrayEqual(current, canonical)) return { content, changed: false };
    lines.splice(range.start, range.end - range.start, ...canonical);
    return { content: joinLines(lines), changed: true };
  }

  // No entry yet. Prefer appending into the LAST root `- insert:` block
  // (so a home patch already carrying other plugins gets one more entry);
  // otherwise start a new top-level `- insert:` block.
  let insertHeader = -1;
  for (let i = 0; i < lines.length; i++) {
    if (INSERT_HEADER_RE.test(lines[i] ?? '')) insertHeader = i;
  }

  if (insertHeader !== -1) {
    // Insert as the first entry of that block (right after the header) so
    // existing sibling entries and any trailing comments stay untouched.
    lines.splice(insertHeader + 1, 0, ...canonical);
    return { content: joinLines(lines), changed: true };
  }

  // No root insert block — start a new one. A brand-new file gets the block
  // directly; an existing patch file gets it after a blank-line separator.
  const fresh = lines.length === 1 && lines[0] === '';
  if (fresh) {
    return { content: '- insert:\n' + canonical.join('\n') + '\n', changed: true };
  }
  const text = joinLines(lines);
  return {
    content: text + '\n' + '- insert:\n' + canonical.join('\n') + '\n',
    changed: true,
  };
}

/**
 * Remove every codegraph entry from a patch file. Drops a root `- insert:`
 * block that becomes empty, and the whole file if only comments remain.
 */
function removeCodeGraphEntry(content: string): {
  content: string;
  removed: boolean;
  empty: boolean;
} {
  const lines = splitLines(content);
  let removed = false;

  // Remove every codegraph entry (not just the first) via the same
  // ENTRY_ID marker the rest of the file keys off.
  for (let idx = findEntryLine(lines, ENTRY_ID); idx !== -1; idx = findEntryLine(lines, ENTRY_ID)) {
    const range = entryRange(lines, idx);
    lines.splice(range.start, range.end - range.start);
    removed = true;
  }

  // Drop root `- insert:` blocks that now hold no entries.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (INSERT_HEADER_RE.test(line)) {
      // Consume this block's blank lines and nested list items only.
      let j = i + 1;
      let hasNested = false;
      while (j < lines.length) {
        const l = lines[j] ?? '';
        if (l.trim() === '') {
          j++;
          continue;
        }
        if (/^ {2,}\S/.test(l)) {
          hasNested = true;
          j++;
          continue;
        }
        break;
      }
      if (!hasNested) {
        i = j; // block emptied — drop it and its trailing blanks
        continue;
      }
    }
    out.push(line);
  }

  if (!removed) return { content, removed: false, empty: false };
  const joined = joinLines(out);
  const empty = joined.trim() === '' || out.every((l) => l.trim() === '' || l.trim().startsWith('#'));
  return { content: joined, removed: true, empty };
}

function hasCodeGraphEntry(content: string): boolean {
  return findEntryLine(splitLines(content), ENTRY_ID) !== -1;
}

class DshTarget implements AgentTarget {
  readonly id = 'dsh' as const;
  readonly displayName = 'DeepSeek Harness';
  readonly docsUrl = 'https://github.com/deepseek-ai/deepseek-harness';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const home = homePatchPath();
    const installed = fs.existsSync(dshHome()) || fs.existsSync(home);
    let alreadyConfigured = hasCodeGraphEntry(readTextFile(home));
    // A per-profile entry also counts as configured (install will migrate
    // it up to the home-level layer to avoid a same-serverName collision).
    if (!alreadyConfigured) {
      alreadyConfigured = profilePatchPaths().some((p) => hasCodeGraphEntry(readTextFile(p)));
    }
    return { installed, alreadyConfigured, configPath: home };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['DeepSeek Harness config lives under $DSH_HOME; re-run with --location=global.'],
      };
    }
    const files: WriteResult['files'] = [];

    const file = homePatchPath();
    const existed = fs.existsSync(file);
    const before = readTextFile(file);
    const { content, changed } = upsertCodeGraphEntry(before);
    if (changed) {
      atomicWriteFileSync(file, content);
      files.push({ path: file, action: existed ? 'updated' : 'created' });
    } else {
      files.push({ path: file, action: 'unchanged' });
    }

    // Self-heal: migrate any per-profile codegraph entry up to the
    // home-level layer so the same `serverName` never mounts twice.
    files.push(...sweepProfileEntries());

    return {
      files,
      notes: ['DSH applies MCP changes live via HMR; start a new session if the tools don\'t appear.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];
    const file = homePatchPath();

    if (fs.existsSync(file)) {
      const before = readTextFile(file);
      const { content, removed, empty } = removeCodeGraphEntry(before);
      if (removed) {
        if (empty) {
          try { fs.unlinkSync(file); } catch { /* ignore */ }
        } else {
          atomicWriteFileSync(file, content);
        }
        files.push({ path: file, action: 'removed' });
      } else {
        files.push({ path: file, action: 'not-found' });
      }
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    // Full reversal: sweep any per-profile codegraph entry too, so a
    // profile-only install (which detect() reports as configured) is removed
    // as well — keeping detect() and uninstall() symmetric.
    files.push(...sweepProfileEntries());

    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# DeepSeek Harness config lives under $DSH_HOME; use --location=global.\n';
    }
    const snippet = ['- insert:', ...renderCodeGraphEntry()].join('\n');
    return `# Add to ${homePatchPath()}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [homePatchPath()] : [];
  }
}

/**
 * Strip a codegraph entry from every per-profile `cordis.patch.yml`
 * (home-level composes after the profile layer, so a leftover same-name
 * entry there would collide). Returns only files actually changed, keeping
 * install output quiet when there is nothing to heal.
 */
function sweepProfileEntries(): WriteResult['files'] {
  const out: WriteResult['files'] = [];
  for (const file of profilePatchPaths()) {
    if (!fs.existsSync(file)) continue;
    const before = readTextFile(file);
    if (!hasCodeGraphEntry(before)) continue;
    const { content, removed, empty } = removeCodeGraphEntry(before);
    if (!removed) continue;
    if (empty) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    } else {
      atomicWriteFileSync(file, content);
    }
    out.push({ path: file, action: 'removed' });
  }
  return out;
}

export const dshTarget: AgentTarget = new DshTarget();