/**
 * Google Antigravity IDE target. Antigravity is Google's VS Code-derived
 * multi-agent IDE; the Gemini CLI is in the process of consolidating with
 * it under a single agent platform. Antigravity reads MCP server
 * definitions from a separate config file from the CLI.
 *
 * ## Config path: unified vs legacy
 *
 * Antigravity recently migrated to a **unified** MCP config path shared
 * across all Antigravity tools:
 *
 *   - **Unified** (post-migration, current): `~/.gemini/config/mcp_config.json`
 *     — signalled by the `~/.gemini/config/.migrated` marker file.
 *   - **Legacy** (pre-migration): `~/.gemini/antigravity/mcp_config.json`
 *     — what the github-mcp-server install guide still documents.
 *
 * We detect the marker at install time and write to the right path. On
 * uninstall we sweep BOTH — so a user who installed on the legacy path,
 * was then auto-migrated by Antigravity, and re-ran `codegraph install`
 * doesn't end up with stale codegraph entries in two files.
 *
 * ## Entry shape: no `type: stdio` field
 *
 * Antigravity rejects MCP entries that carry the `type: "stdio"` field
 * the rest of our targets use — the working entries it manages itself
 * (e.g. `code-review-graph`) omit it, and dropping it was load-bearing
 * to get codegraph to appear in the Customizations UI. We build the
 * entry locally instead of routing through `getMcpServerConfig()`.
 *
 * ## macOS GUI app PATH resolution
 *
 * Antigravity is a GUI Electron app. macOS gives Dock/Finder-launched
 * apps a stripped PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — nvm-managed
 * tools live outside that, so a bare `codegraph` command fails to spawn
 * even when `which codegraph` resolves in the user's shell. We resolve
 * `codegraph` to its absolute path on macOS at install time. (Linux GUI
 * apps inherit user PATH; Windows uses `PATH` env directly — both are
 * fine with the bare command.)
 *
 * ## Shared instructions (no GEMINI.md from here)
 *
 * The IDE shares `~/.gemini/GEMINI.md` with Gemini CLI for instructions
 * — written by the `./gemini.ts` target. We deliberately don't touch it
 * here so uninstalling Antigravity without uninstalling Gemini CLI
 * leaves CLI instructions intact. Users who install only Antigravity
 * still get a working MCP integration; the prefer-codegraph-over-grep
 * guidance just won't be present unless they also install the gemini
 * target.
 *
 * ## Location
 *
 * `supportsLocation('local')` returns false — Antigravity has no
 * project-scoped config concept as of 2026-05.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function unifiedConfigDir(): string {
  return path.join(os.homedir(), '.gemini', 'config');
}
function unifiedMcpConfigPath(): string {
  return path.join(unifiedConfigDir(), 'mcp_config.json');
}
function legacyConfigDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}
function legacyMcpConfigPath(): string {
  return path.join(legacyConfigDir(), 'mcp_config.json');
}
function migratedMarkerPath(): string {
  return path.join(unifiedConfigDir(), '.migrated');
}

/**
 * Pick the right MCP config path to write to.
 *
 * Prefers the unified `~/.gemini/config/mcp_config.json` when Antigravity
 * has signalled it's migrated (`.migrated` marker present, OR the
 * unified file already exists — Antigravity creates it on first
 * launch post-migration). Falls back to the legacy
 * `~/.gemini/antigravity/mcp_config.json` for users on a pre-migration
 * Antigravity build.
 */
function preferredMcpConfigPath(): string {
  if (fs.existsSync(migratedMarkerPath())) return unifiedMcpConfigPath();
  if (fs.existsSync(unifiedMcpConfigPath())) return unifiedMcpConfigPath();
  return legacyMcpConfigPath();
}

/**
 * Resolve the on-disk path of the `codegraph` binary so a Mac GUI app
 * launched from Dock/Finder (with a stripped PATH) can find it. Falls
 * back to the bare `codegraph` name when:
 *
 *  - we're not on macOS (Linux GUI apps inherit user PATH; Windows
 *    uses env PATH directly), OR
 *  - the lookup fails for any reason (preserving install in restricted
 *    environments where `which`/`command -v` aren't available).
 *
 * Resolution prefers `command -v` (built-in, no PATH manipulation),
 * with `which` as a fallback. Both are read via the user's interactive
 * shell PATH at install time — that's the right PATH for finding
 * nvm-managed tools like ours.
 */
function resolveCodegraphCommand(): string {
  if (process.platform !== 'darwin') return 'codegraph';
  try {
    const resolved = execSync('command -v codegraph || which codegraph', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/bash',
      windowsHide: true,
    }).trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through to bare name */
  }
  return 'codegraph';
}

/**
 * Build the codegraph MCP-server entry for Antigravity. Distinct from
 * `getMcpServerConfig()` because Antigravity (a) rejects the `type`
 * field and (b) needs an absolute command path on macOS — see file
 * header.
 */
function buildAntigravityEntry(): { command: string; args: string[] } {
  return {
    command: resolveCodegraphCommand(),
    args: ['serve', '--mcp'],
  };
}

class AntigravityTarget implements AgentTarget {
  readonly id = 'antigravity' as const;
  readonly displayName = 'Antigravity IDE';
  readonly docsUrl = 'https://antigravity.google';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = preferredMcpConfigPath();
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // "Installed" heuristic: either the unified config dir, the legacy
    // config dir, or one of the config files exists. Antigravity creates
    // ~/.gemini/ on first launch even before MCP configs.
    const installed =
      fs.existsSync(unifiedConfigDir()) ||
      fs.existsSync(legacyConfigDir()) ||
      fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Antigravity IDE has no project-local config — re-run with --location=global.'],
      };
    }
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry());
    // If the user originally installed on the legacy path and Antigravity
    // has since migrated, strip the stale legacy entry so they don't
    // wind up with two competing codegraph configs.
    const legacyCleanup = cleanupLegacyEntry();
    if (legacyCleanup) files.push(legacyCleanup);
    return {
      files,
      notes: ['Restart Antigravity for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];

    // Remove from the preferred path.
    const preferred = preferredMcpConfigPath();
    files.push(removeCodegraphFromFile(preferred));

    // Also sweep the OTHER path (legacy when preferred is unified, and
    // vice versa) — handles the migration-half-state case where codegraph
    // got written to one file but Antigravity now reads from the other.
    const other = preferred === unifiedMcpConfigPath()
      ? legacyMcpConfigPath()
      : unifiedMcpConfigPath();
    if (preferred !== other) {
      const otherResult = removeCodegraphFromFile(other);
      // Only surface the secondary file if we actually touched it —
      // a `not-found` on a file the user never had is noise.
      if (otherResult.action === 'removed') files.push(otherResult);
    }

    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Antigravity IDE has no project-local config — use --location=global.\n';
    }
    const file = preferredMcpConfigPath();
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildAntigravityEntry() } }, null, 2);
    return `# Add to ${file}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [preferredMcpConfigPath()];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = preferredMcpConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildAntigravityEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Strip the codegraph entry from the legacy `~/.gemini/antigravity/mcp_config.json`
 * if it's present AND we're writing to the unified path. Used by install
 * to migrate users who had codegraph configured on the legacy path
 * before Antigravity migrated their config. Returns the file action for
 * reporting, or `null` when there's nothing to clean up.
 */
function cleanupLegacyEntry(): WriteResult['files'][number] | null {
  if (preferredMcpConfigPath() !== unifiedMcpConfigPath()) return null;
  const legacy = legacyMcpConfigPath();
  if (!fs.existsSync(legacy)) return null;
  const config = readJsonFile(legacy);
  if (!config.mcpServers?.codegraph) return null;
  delete config.mcpServers.codegraph;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonFile(legacy, config);
  return { path: legacy, action: 'removed' };
}

function removeCodegraphFromFile(file: string): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const config = readJsonFile(file);
  if (!config.mcpServers?.codegraph) return { path: file, action: 'not-found' };
  delete config.mcpServers.codegraph;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  // Leave a now-empty `{}` in place — Antigravity manages this file and
  // a stray empty file is less surprising than a deletion.
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const antigravityTarget: AgentTarget = new AntigravityTarget();
