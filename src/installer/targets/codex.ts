/**
 * OpenAI Codex CLI target.
 *
 *   - MCP server entry to `config.toml` as the dotted-key table
 *     `[mcp_servers.codegraph]`. TOML — not JSON — handled by the
 *     narrow serializer in `./toml.ts`.
 *   - Instructions to `AGENTS.md`.
 *
 * Both locations are supported (#1531):
 *   - global: `~/.codex/config.toml` + `~/.codex/AGENTS.md`
 *   - local:  `<cwd>/.codex/config.toml` + `<cwd>/AGENTS.md`
 *
 * Codex has a first-class project config layer: `.codex/config.toml`
 * is layer 4 of the loader's stack, above the user config (layer 6),
 * merged recursively top-over-bottom
 * (`codex-rs/config/src/loader/README.md` in openai/codex). It landed
 * in openai/codex#8354 (2025-12-22), so the "Codex has no
 * project-local config" note this file used to carry was never
 * accurate. The project layer strips a denylist of settings that
 * repo contents shouldn't get to choose (base URLs, model providers,
 * `notify`, profiles, otel — `loader/mod.rs`), and `mcp_servers` is
 * NOT on it, so a project-scoped `[mcp_servers.codegraph]` is honored.
 *
 * Caveat surfaced as an install note: project layers are "loaded but
 * disabled when untrusted," so a local install only takes effect in a
 * project the user has marked trusted.
 *
 * No permissions concept.
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
  atomicWriteFileSync,
  codegraphBinary,
  getMcpServerConfig,
  isSessionHookCommand,
  mergeHookEntries,
  pruneHookCommands,
  removeMarkedSection,
  upsertInstructionsEntry,
  writeJsonFile,
  type HookEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import { buildTomlTable, readTomlTableBody, removeTomlTable, upsertTomlTable } from './toml';
import { createHash } from 'crypto';

const TOML_HEADER = 'mcp_servers.codegraph';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.codex')
    : path.join(process.cwd(), '.codex');
}
function tomlConfigPath(loc: Location): string {
  return path.join(configDir(loc), 'config.toml');
}
function instructionsPath(loc: Location): string {
  // Global AGENTS.md lives under ~/.codex/; project-local AGENTS.md
  // lives at the project root (NOT under .codex/) — that's the file
  // Codex reads for repo instructions, and it matches the local
  // layout the opencode and gemini targets already use.
  return loc === 'global'
    ? path.join(configDir('global'), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

/**
 * Codex discovers hooks from a `hooks.json` in each config layer's `.codex/`
 * folder — `~/.codex/hooks.json` for the user layer, `<cwd>/.codex/hooks.json`
 * for the project layer (`hooks_config_folder` in codex's `config/src/state.rs`)
 * — which is the same global/local split the TOML config already uses.
 */
function hooksJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'hooks.json');
}

/**
 * Project layers are "loaded but disabled when untrusted" (openai/codex
 * `loader/mod.rs`), so a local install can be written correctly and
 * still do nothing. Say so rather than reporting silent success.
 */
function trustNote(): string {
  return `Codex applies ${tomlConfigPath('local')} only in a project marked trusted — otherwise the layer is loaded but disabled. Trust this project in Codex to activate it.`;
}

/**
 * The per-context session hooks, as codex spells them.
 *
 * `PreToolUse`'s matcher is a regex tested against the tool name, so the bare
 * name matches however the server ends up namespaced. It declares `--agent
 * codex` because codex requires `permissionDecision` paired with the rewrite
 * and drops an unpaired one — the hook emits that field for no other agent,
 * and learns which one it serves from this flag rather than from the payload.
 *
 * `PostCompact` — codex gates it behind compaction SUCCESS in three of its
 * four compaction paths, and in all four every failure path returns before
 * the history rewrite commits, so a failed compaction leaves the agent's
 * context intact. Skipping the reset there is exactly right; PreCompact would
 * clear a still-valid record on every failed attempt. It carries no matcher,
 * which codex reads as every trigger — manual and auto alike.
 */
const SESSION_HOOKS: HookEntry[] = [
  { event: 'PreToolUse', matcher: 'codegraph_explore', subcommand: 'hooks pre-tool-use --agent codex' },
  { event: 'PostCompact', subcommand: 'hooks post-compact' },
];

/**
 * Parse a `hooks.json`, or `null` when it is unusable.
 *
 * Deliberately NOT `readJsonFile`: that one backs a broken file up and returns
 * `{}`, which here would mean writing our hooks over config we failed to read.
 * Codex would then run our file instead of the user's, so an unparseable
 * hooks.json is left exactly as it is.
 */
function readHooksJson(file: string): Record<string, any> | null {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Wire the session hooks into this location's `hooks.json`, creating the file
 * when it doesn't exist. Surgical: existing events, groups and unrelated
 * top-level keys are preserved, ours is appended, and a re-run that finds
 * everything already in place leaves the bytes untouched.
 *
 * Codex holds hook trust per ENTRY, in `[hooks.state]` inside config.toml: each
 * handler carries a hash of its own normalized identity. Writing that state
 * ourselves would stamp our hooks as reviewed and skip the review the user is
 * entitled to, so the installer never touches it — and adding entries leaves
 * every hook the user already trusted trusted. Nothing here announces that:
 * codex's own TUI surfaces untrusted hooks on its next run, so the install
 * reports this file the way it reports every other one, as a file action.
 */
export function writeSessionHookEntries(loc: Location): WriteResult['files'][number] {
  const file = hooksJsonPath(loc);
  const created = !fs.existsSync(file);
  const root = readHooksJson(file);
  if (!root) {
    console.warn(`  Warning: ${file} is not valid JSON — leaving it untouched.`);
    console.warn('  Fix the file and re-run "codegraph install" to wire the CodeGraph hooks.');
    return { path: file, action: 'unchanged' };
  }

  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    root.hooks = {};
  }
  const changed = mergeHookEntries(root.hooks, SESSION_HOOKS, codegraphBinary());
  if (!changed && !created) return { path: file, action: 'unchanged' };

  writeJsonFile(file, root);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * Codex's snake_case label for each event we wire. It spells the event both in
 * a hook's trust identity and in its `[hooks.state]` key.
 */
const HOOK_EVENT_KEY_LABEL: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PostCompact: 'post_compact',
};

/** What codex normalizes an unset command-hook `timeout` to, in seconds. */
const CODEX_DEFAULT_HOOK_TIMEOUT_SEC = 600;

/** Recursively key-sorted copy — codex canonicalizes before hashing. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((k) => [k, canonicalJson(source[k])]));
  }
  return value;
}

/**
 * Reproduce the trust hash codex computes for one handler.
 *
 * Codex hashes a NORMALIZED identity rather than the source text, so that the
 * same hook expressed in config.toml and in hooks.json converges: the event's
 * snake_case label, the group's matcher, and the one handler with its defaults
 * filled in — an unset `timeout` becoming {@link CODEX_DEFAULT_HOOK_TIMEOUT_SEC}
 * and `async` defaulting to false. That is serialized to TOML (which drops unset
 * optionals), converted to JSON, key-sorted at every level, and SHA-256'd.
 *
 * Pinned against real trusted entries in the fixture test — this reimplements
 * another project's internal, so the test is what says it still agrees. If codex
 * changes its normalization the hash simply stops matching, and codex reports
 * the entry as needing review and asks in its own TUI, exactly as it does for a
 * hook nobody has trusted. A stale hash can never read as trusted.
 */
export function codexHookTrustHash(
  event: string,
  matcher: string | undefined,
  command: string,
  statusMessage?: string,
): string {
  const handler: Record<string, unknown> = {
    type: 'command',
    command,
    async: false,
    timeout: CODEX_DEFAULT_HOOK_TIMEOUT_SEC,
  };
  // Unset optionals are absent, not empty — see the matcher note below. Ours
  // never carry a statusMessage; the parameter exists so the fixture test can
  // hash a real-world handler that does.
  if (statusMessage !== undefined) handler.statusMessage = statusMessage;
  const identity: Record<string, unknown> = {
    event_name: HOOK_EVENT_KEY_LABEL[event] ?? event,
    hooks: [handler],
  };
  // An absent matcher is absent from the identity, not an empty string: TOML
  // has no null, so codex's own serialization drops the key entirely.
  if (matcher !== undefined) identity.matcher = matcher;
  const canonical = JSON.stringify(canonicalJson(identity));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Locate our handlers in a written hooks.json and describe each the way codex
 * will: its `[hooks.state]` key and its current trust hash.
 *
 * The key carries the handler's POSITION (`<source>:<event>:<group>:<handler>`),
 * so the indices are read back off the file we just wrote rather than assumed —
 * ours may sit after any number of the user's groups.
 */
function ourHookTrustState(file: string, root: Record<string, any>): Array<{ key: string; hash: string }> {
  const found: Array<{ key: string; hash: string }> = [];
  for (const { event, subcommand } of SESSION_HOOKS) {
    const groups: any[] = Array.isArray(root.hooks?.[event]) ? root.hooks[event] : [];
    const stable = subcommand.split(' --')[0] ?? subcommand;
    groups.forEach((group, groupIndex) => {
      const handlers: any[] = group && Array.isArray(group.hooks) ? group.hooks : [];
      handlers.forEach((handler, handlerIndex) => {
        const command = handler?.command;
        if (typeof command !== 'string') return;
        if (!isSessionHookCommand(command) || !command.includes(stable)) return;
        found.push({
          key: `${file}:${HOOK_EVENT_KEY_LABEL[event] ?? event}:${groupIndex}:${handlerIndex}`,
          // Hash the matcher AS WRITTEN, which is what codex will read back.
          hash: codexHookTrustHash(event, typeof group.matcher === 'string' ? group.matcher : undefined, command),
        });
      });
    });
  }
  return found;
}

/**
 * Record our two hooks as trusted in this layer's config.toml.
 *
 * This is the one place the installer writes `[hooks.state]`, and it is not
 * gated on a question. Codex's TUI review guards hooks that ARRIVE from
 * somewhere the user didn't choose — a cloned repo's project hooks.json, say —
 * and an installer the user just invoked, writing its own two entries pointing
 * at its own binary, is not that threat; the Claude target installs its hooks
 * without asking for the same reason. A local install's state also still sits
 * behind codex's project-trust gate, so nothing runs in a project the user
 * hasn't trusted anyway.
 *
 * Trust is held PER ENTRY, so what is written can only ever be the entries we
 * wrote ourselves, keyed by their own position — the user's hooks are
 * unreachable from here, and their trust records are never read, rewritten, or
 * invalidated by ours.
 *
 * The launcher path is part of the hashed identity and changes with every
 * version, so an existing record is UPDATED rather than skipped; only its
 * `trusted_hash` line is replaced, keeping any `enabled` the user set in the
 * codex TUI (re-enabling a hook they turned off is not ours to do).
 *
 * ponytail: a record is keyed by POSITION, so if our group's index ever shifts
 * — a user inserting a group ahead of ours in the same file — the record for
 * the old position is left behind. Harmless (its hash matches nothing at the
 * new position, so codex asks rather than trusting) but untidy; prune it here
 * if that ever stops being rare, taking care not to delete a record the user
 * made for a hook of their own in the same file.
 */
function writeHookTrustState(loc: Location, entries: Array<{ key: string; hash: string }>): boolean {
  const file = tomlConfigPath(loc);
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  let changed = false;

  for (const { key, hash } of entries) {
    const header = `hooks.state.${JSON.stringify(key)}`;
    const existing = readTomlTableBody(content, header) ?? [];
    const body = [
      `trusted_hash = ${JSON.stringify(hash)}`,
      ...existing.filter((line) => !/^\s*trusted_hash\s*=/.test(line)),
    ].join('\n');
    const { content: next, action } = upsertTomlTable(content, header, `[${header}]\n${body}`);
    if (action !== 'unchanged') changed = true;
    content = next;
  }

  if (changed) atomicWriteFileSync(file, content);
  return changed;
}

/** Drop the trust records for our own hooks, and nothing else. */
function removeHookTrustState(loc: Location, entries: Array<{ key: string; hash: string }>): boolean {
  const file = tomlConfigPath(loc);
  if (!fs.existsSync(file)) return false;
  let content = fs.readFileSync(file, 'utf-8');
  let changed = false;
  for (const { key } of entries) {
    const { content: next, action } = removeTomlTable(content, `hooks.state.${JSON.stringify(key)}`);
    if (action === 'removed') changed = true;
    content = next;
  }
  if (changed) atomicWriteFileSync(file, content.trimEnd() + '\n');
  return changed;
}

/**
 * Remove the session hooks this installer wrote. Leaves the user's own hooks,
 * and any other top-level key, alone; deletes the file only when removing ours
 * empties it completely — i.e. only when we were the ones who created it.
 */
export function removeSessionHookEntries(loc: Location): WriteResult['files'][number] {
  const file = hooksJsonPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const root = readHooksJson(file);
  if (!root || !root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    return { path: file, action: 'unchanged' };
  }
  if (!pruneHookCommands(root.hooks, isSessionHookCommand)) {
    return { path: file, action: 'unchanged' };
  }
  if (Object.keys(root.hooks).length === 0) delete root.hooks;

  if (Object.keys(root).length === 0) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  } else {
    writeJsonFile(file, root);
  }
  return { path: file, action: 'removed' };
}

/** Our hooks as they now sit on disk, keyed and hashed the way codex will. */
function hookTrustEntries(loc: Location): Array<{ key: string; hash: string }> {
  const file = hooksJsonPath(loc);
  const root = readHooksJson(file);
  return root ? ourHookTrustState(file, root) : [];
}

class CodexTarget implements AgentTarget {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly docsUrl = 'https://github.com/openai/codex';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const tomlPath = tomlConfigPath(loc);
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch { /* ignore */ }
    }
    // Global: ~/.codex/ existing means Codex has run here. Local: the
    // project only counts as "Codex-enabled" once it actually has a
    // .codex/ dir or config file of its own.
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(tomlPath);
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    const mcp = writeMcpEntry(loc);

    // Per-context session hooks. They are what tells the server WHICH agent
    // context a call belongs to; without them its already-sent record stays
    // keyed per MCP connection. Their trust records go in unconditionally —
    // see writeHookTrustState — and the write no-ops once they are right.
    const hooks = writeSessionHookEntries(loc);
    const trustChanged = writeHookTrustState(loc, hookTrustEntries(loc));

    // The MCP entry and the trust records share config.toml, so it is reported
    // once, as whichever write actually touched it.
    files.push(trustChanged && mcp.action === 'unchanged' ? { path: mcp.path, action: 'updated' } : mcp);
    files.push(hooks);

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return loc === 'local' ? { files, notes: [trustNote()] } : { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // Read the keys off hooks.json BEFORE it is stripped — they are derived
    // from the handlers' positions in it.
    removeHookTrustState(loc, hookTrustEntries(loc));

    const tomlPath = tomlConfigPath(loc);
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
      if (action === 'removed') {
        if (nextContent.trim() === '') {
          try { fs.unlinkSync(tomlPath); } catch { /* ignore */ }
        } else {
          atomicWriteFileSync(tomlPath, nextContent.trimEnd() + '\n');
        }
        files.push({ path: tomlPath, action: 'removed' });
      } else {
        files.push({ path: tomlPath, action: 'not-found' });
      }
    } else {
      files.push({ path: tomlPath, action: 'not-found' });
    }

    const hooks = removeSessionHookEntries(loc);
    if (hooks.action === 'removed') files.push(hooks);

    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const block = buildCodegraphBlock();
    return `# Add to ${tomlConfigPath(loc)}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    return [tomlConfigPath(loc), hooksJsonPath(loc), instructionsPath(loc)];
  }
}

function buildCodegraphBlock(): string {
  const mcp = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = tomlConfigPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const block = buildCodegraphBlock();
  // Single read — `existing === ''` derives both "is the file empty
  // or absent" and "what was its content," avoiding a TOCTOU window
  // between two `fs.existsSync` calls.
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const created = existing.length === 0;
  const { content: nextContent, action } = upsertTomlTable(existing, TOML_HEADER, block);

  if (action === 'unchanged') {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, nextContent);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * Strip the marker-delimited CodeGraph block from this location's
 * AGENTS.md if a prior install wrote one. Used by both install
 * (self-heal on upgrade) and uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const codexTarget: AgentTarget = new CodexTarget();
