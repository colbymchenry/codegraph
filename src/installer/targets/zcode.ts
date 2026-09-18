/**
 * ZCode target — the ZCode desktop coding agent.
 *
 * Writes:
 *
 *   - MCP server entry to `~/.zcode/cli/config.json` under `mcp.servers`
 *     (global = user scope, loads in every workspace) or
 *     `./.zcode/config.json` (local = workspace scope). Both scopes
 *     auto-connect at session start.
 *   - Instructions to `~/.zcode/AGENTS.md` (global) or `./AGENTS.md`
 *     (local). ZCode reads AGENTS.md — the user file loads first, then
 *     the workspace file narrows it — so the conditional block wording
 *     works in both scopes.
 *   - UserPromptSubmit prompt-hook into the same config.json under
 *     `hooks`.
 *
 * Three ZCode-specific differences from the other JSON targets, all
 * verified against a live ZCode install:
 *
 *  1. MCP servers are NESTED under `mcp.servers` — not the top-level
 *     `mcpServers` key Claude/Cursor/opencode use. A Claude-style
 *     snippet pasted verbatim silently does nothing.
 *  2. Server entries carry no `type` field. ZCode's own bundled
 *     servers (`node_repl`, `computer-use`) and a verified-working
 *     codegraph entry are bare `{ command, args }`; tolerance for a
 *     `type: "stdio"` key is unverified, so we don't write one (and we
 *     normalize a hand-copied Claude-style entry down to the verified
 *     shape on install).
 *  3. Hooks share the config.json under `hooks`, and a config-file
 *     hooks block only runs when `hooks.enabled: true` — hooks
 *     contributed by plugins auto-enable the hook runner, config-file
 *     hooks do not. Hook entries are process-shaped
 *     (`{ type: 'process', command, args, timeoutMs }`), not Claude's
 *     `{ type: 'command', command: '<shell string>' }`.
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
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  writeJsonFile,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function configPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.zcode', 'cli', 'config.json')
    : path.join(process.cwd(), '.zcode', 'config.json');
}

function instructionsPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.zcode', 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

/**
 * The verified ZCode server-entry shape: no `type` key (see module
 * comment, point 2). Everything else ZCode needs to connect is the
 * plain stdio command line.
 */
function getZcodeMcpServerConfig(): { command: string; args: string[] } {
  return {
    command: 'codegraph',
    args: ['serve', '--mcp'],
  };
}

/**
 * The prompt-hook entry the installer writes. ZCode spawns hooks as a
 * process with an argv array, so the platform handling differs from
 * Claude's shell-string hooks (#1466): on Windows the spawned binary
 * must be `codegraph.cmd` (a bare `codegraph` does not resolve through
 * PATHEXT when spawned directly), elsewhere plain `codegraph`.
 */
const PROMPT_HOOK_COMMAND = process.platform === 'win32' ? 'codegraph.cmd' : 'codegraph';
const PROMPT_HOOK_ARGS = ['prompt-hook'];
/** Matches the 30s ceiling the bundled ZCode plugins use for UserPromptSubmit. */
const PROMPT_HOOK_TIMEOUT_MS = 30000;

/**
 * True when a hooks-array entry is the prompt hook we write (either
 * platform's command spelling — a config carried across machines can
 * hold the other one). Sibling process hooks never match: the command
 * basename must be `codegraph`/`codegraph.cmd` AND argv must carry
 * `prompt-hook`.
 */
function isPromptHookEntry(h: unknown): boolean {
  if (!h || typeof h !== 'object') return false;
  const hook = h as Record<string, any>;
  if (hook.type !== 'process' || typeof hook.command !== 'string') return false;
  const base = path.basename(hook.command).replace(/\.exe$/i, '');
  if (base !== 'codegraph' && base !== 'codegraph.cmd') return false;
  return Array.isArray(hook.args) && hook.args.some((a) => a === 'prompt-hook');
}

class ZcodeTarget implements AgentTarget {
  readonly id = 'zcode' as const;
  readonly displayName = 'ZCode';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = configPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcp?.servers?.codegraph;
    const installed =
      fs.existsSync(mcpPath) ||
      fs.existsSync(instructionsPath(loc)) ||
      (loc === 'global' && fs.existsSync(path.join(os.homedir(), '.zcode')));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry (nested mcp.servers).
    files.push(writeMcpEntry(loc));

    // 2. Front-load prompt hook. `promptHook === true` writes it;
    // `=== false` strips a prior install's hook so opting out
    // round-trips; `undefined` leaves it untouched. ZCode has no
    // permissions/auto-allow surface, so `autoAllow` is a no-op here.
    if (opts.promptHook === true) {
      files.push(writePromptHookEntry(loc));
    } else if (opts.promptHook === false) {
      const removed = removePromptHookEntry(loc);
      if (removed.action === 'removed') files.push(removed);
    }

    // 3. AGENTS.md instructions — same marker-fenced block as Claude
    // (#704): ZCode subagents see AGENTS.md but not the MCP initialize
    // instructions, and the shell fallback covers non-MCP sessions.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return {
      files,
      notes: ['Restart ZCode sessions to apply (instructions and hooks load at session start).'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry — surgical: only `mcp.servers.codegraph` is
    // removed; sibling servers, `plugins`, and every other top-level
    // key in config.json are preserved.
    const mcpFile = configPath(loc);
    const config = readJsonFile(mcpFile);
    if (config.mcp?.servers?.codegraph) {
      delete config.mcp.servers.codegraph;
      if (config.mcp.servers && Object.keys(config.mcp.servers).length === 0) {
        delete config.mcp.servers;
      }
      if (config.mcp && Object.keys(config.mcp).length === 0) {
        delete config.mcp;
      }
      writeJsonFile(mcpFile, config);
      files.push({ path: mcpFile, action: 'removed' });
    } else {
      files.push({ path: mcpFile, action: 'not-found' });
    }

    // 2. Prompt hook.
    const hookCleanup = removePromptHookEntry(loc);
    if (hookCleanup.action === 'removed') files.push(hookCleanup);

    // 3. Instructions — strip the marker block, keep user content.
    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify(
      { mcp: { servers: { codegraph: getZcodeMcpServerConfig() } } },
      null,
      2,
    );
    return `# Add to ${target} (merge under the existing "mcp"."servers" when present)\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc), instructionsPath(loc)];
  }
}

/**
 * Write the `mcp.servers.codegraph` entry into the ZCode config.json.
 * Idempotent (byte-equal re-runs report `unchanged`), and normalizes a
 * hand-copied Claude-style entry (which carries `type: "stdio"`) down
 * to the verified ZCode shape. All sibling keys — including other
 * servers under `mcp.servers` and the top-level `plugins` block — are
 * preserved verbatim.
 */
export function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const existing = readJsonFile(file);
  if (!existing.mcp || typeof existing.mcp !== 'object' || Array.isArray(existing.mcp)) {
    existing.mcp = {};
  }
  if (!existing.mcp.servers || typeof existing.mcp.servers !== 'object' || Array.isArray(existing.mcp.servers)) {
    existing.mcp.servers = {};
  }
  const before = existing.mcp.servers.codegraph;
  const after = getZcodeMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before || fs.existsSync(file) ? 'updated' : 'created';
  existing.mcp.servers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Write the front-load `UserPromptSubmit` hook into the ZCode
 * config.json (see the class comment for the shape). Sets
 * `hooks.enabled: true` — config-file hooks are inert without it — and
 * appends our process entry only when no prompt-hook entry exists yet.
 * Sibling hooks in the same event survive untouched. Idempotent:
 * re-runs leave a byte-identical file and report `unchanged`.
 */
export function writePromptHookEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const created = !fs.existsSync(file);
  const config = readJsonFile(file);

  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  if (!Array.isArray(config.hooks.UserPromptSubmit)) config.hooks.UserPromptSubmit = [];

  let changed = false;
  if (config.hooks.enabled !== true) {
    config.hooks.enabled = true;
    changed = true;
  }

  const already = config.hooks.UserPromptSubmit.some(
    (g: any) => g && Array.isArray(g.hooks) && g.hooks.some(isPromptHookEntry),
  );
  if (!already) {
    config.hooks.UserPromptSubmit.push({
      hooks: [
        {
          type: 'process',
          command: PROMPT_HOOK_COMMAND,
          args: PROMPT_HOOK_ARGS,
          timeoutMs: PROMPT_HOOK_TIMEOUT_MS,
        },
      ],
    });
    changed = true;
  }

  if (!changed) {
    return { path: file, action: 'unchanged' };
  }
  writeJsonFile(file, config);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * Remove the prompt-hook entries this installer wrote, surgically:
 * only entries matching `isPromptHookEntry` are dropped, a matcher
 * group is pruned once its `hooks` array empties, and the
 * `UserPromptSubmit` event once it has no groups left. `hooks.enabled`
 * is deliberately LEFT in place — its provenance is unknowable (the
 * user may rely on it for other config hooks), and a lingering
 * `enabled: true` with no config-file hooks is inert.
 */
export function removePromptHookEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  const config = readJsonFile(file);
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { path: file, action: 'unchanged' };
  }
  const groups = hooks.UserPromptSubmit;
  if (!Array.isArray(groups)) return { path: file, action: 'unchanged' };

  let removedAny = false;
  hooks.UserPromptSubmit = groups.filter((g: any) => {
    if (!g || !Array.isArray(g.hooks)) return true;
    const kept = g.hooks.filter((h: any) => !isPromptHookEntry(h));
    if (kept.length !== g.hooks.length) removedAny = true;
    g.hooks = kept;
    return g.hooks.length > 0;
  });

  if (!removedAny) return { path: file, action: 'unchanged' };
  if (hooks.UserPromptSubmit.length === 0) delete hooks.UserPromptSubmit;

  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

/**
 * Strip the marker-delimited CodeGraph block from AGENTS.md if a prior
 * install wrote one (uninstall, and nothing else — install upserts).
 * `removeMarkedSection` returns `not-found`/`kept` when there's
 * nothing to strip.
 */
export function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const zcodeTarget: AgentTarget = new ZcodeTarget();
