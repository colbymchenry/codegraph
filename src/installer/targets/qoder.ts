/**
 * Qoder IDE target. Writes different files at different locations:
 *
 *   - **`--location=global`** — MCP server entry to Qoder's shared
 *     `mcp.json`, at:
 *       macOS   — `~/Library/Application Support/Qoder/SharedClientCache/mcp.json`
 *                 (verified against a working Qoder install)
 *       Linux   — `$XDG_CONFIG_HOME/Qoder/SharedClientCache/mcp.json`
 *                 (defaults to `~/.config/Qoder/…`)
 *       Windows — `%APPDATA%/Qoder/SharedClientCache/mcp.json`
 *
 *     NOTE: only the macOS path is empirically verified; the Linux and
 *     Windows paths follow the Electron / VS-Code-fork convention and
 *     remain unverified. If Qoder ships those platforms under a different
 *     path (`~/.qoder/`, versioned dir, …) we'll adjust when reports
 *     surface. A wrong path is at worst an orphan `mcp.json` Qoder
 *     never reads — we only create files / directories we fully own,
 *     never overwrite pre-existing user data at the wrong location
 *     (`uninstall` short-circuits on a missing file; `install` only
 *     seeds a fresh JSON tree when none exists).
 *
 *     Same `mcpServers.<name>` JSON schema Claude / Cursor / Kiro use,
 *     so the standard `shared.ts` merge helpers keep sibling MCP servers
 *     intact through install / uninstall round-trips. The `type: "stdio"`
 *     field appears in real working Qoder configs alongside `command` /
 *     `args`, so we emit it too; if a future Qoder rejects it we can drop
 *     the field (Antigravity's target already does).
 *
 *   - **`--location=local`** — the project-scoped "one command sets up
 *     everything you need in this project" install, matching how
 *     opencode / gemini / codex handle their local target. Writes BOTH:
 *
 *       1. the shared user-scope MCP entry (same file as `global` above —
 *          Qoder has NO project-local `mcp.json` path; the in-project
 *          `.qoder/` dir is a cache for MCP purposes but a first-class
 *          rules dir for agent instructions — see (2)), and
 *       2. a Qoder project rule at `./.qoder/rules/codegraph.md`. This
 *          is a deliberate WORKAROUND for Qoder consuming the MCP
 *          `initialize.instructions` field weakly: tools list correctly
 *          and are callable, but Qoder's agent will not proactively
 *          reach for `codegraph_explore` — it continues to grep / read
 *          files even when the MCP tool would give the answer in one
 *          round-trip. **This intentionally departs from issue #529's
 *          "MCP initialize.instructions as single source of truth"
 *          rule** — Cursor / Claude / Kiro all rely on that rule; Qoder
 *          currently doesn't honor it, so we bridge the gap with a
 *          project-local rule. When Qoder starts loading MCP
 *          instructions like the rest, the rule-file branch can be
 *          removed in one commit.
 *
 *          Why `.qoder/rules/` and not `./AGENTS.md`? Both work, but:
 *
 *            - **Precedence.** Qoder's own docs specify that when
 *              `.qoder/rules/*` and `./AGENTS.md` disagree, the rules
 *              directory wins. A project may already have an AGENTS.md
 *              authored by Codex CLI, a teammate, or the user — writing
 *              codegraph guidance into AGENTS.md would either fight
 *              their content (with unpredictable merge outcomes for
 *              Qoder's agent) or ride on top of it. `.qoder/rules/`
 *              guarantees the codegraph guidance is the one Qoder
 *              actually applies for this project.
 *            - **Ownership boundary.** `.qoder/rules/codegraph.md` is
 *              a filename we OWN — no marker fence needed, no risk of
 *              trampling user content, and uninstall is a clean
 *              `unlink`. Same pattern as `~/.kiro/steering/codegraph.md`
 *              used to be; it avoids the whole class of "marker
 *              vs. user-content" bugs that AGENTS.md upsert has to
 *              actively guard against.
 *            - **Cross-target hygiene.** Codex CLI / opencode already
 *              write to `./AGENTS.md` via their own installer targets;
 *              their fence + ours would double-nudge the agent with
 *              near-identical text. Splitting Qoder off to
 *              `.qoder/rules/` avoids that duplication.
 *
 *          On upgrade from an earlier build that wrote `./AGENTS.md`,
 *          both `install` and `uninstall` also strip the legacy
 *          CodeGraph fence from `./AGENTS.md` if present (self-heal),
 *          so users don't end up with two competing hints.
 *
 *     Uninstall on `local` unlinks `./.qoder/rules/codegraph.md`, strips
 *     any legacy `./AGENTS.md` fence, and leaves the shared MCP entry
 *     alone — the MCP entry is user-scope and another project may still
 *     be relying on it, so per-project uninstalls never step on each
 *     other. Removing the MCP entry itself is gated behind
 *     `--location=global` uninstall.
 *
 * `global` never writes a rule file — Qoder only auto-loads project-scoped
 * `.qoder/rules/*` and project-root `AGENTS.md`, so a user-scope rule
 * would apply nowhere. A user who wants MCP without a per-project agent
 * nudge runs `global`; a user who wants both runs `local`, which is a
 * superset of `global` for the current project (matches
 * opencode / gemini / codex).
 *
 * Two Qoder-specific quirks force this file to look different from
 * Kiro / Claude:
 *
 * 1. **No `${workspaceFolder}` substitution.** Unlike VS Code, Cursor,
 *    and most VS Code forks, Qoder (at least older builds) passes MCP
 *    `args` to the child process verbatim. A `--path "${workspaceFolder}"`
 *    therefore reaches codegraph as the literal 12-character string,
 *    `findNearestCodeGraphRoot` returns null, and the (pre-#964) empty
 *    `tools/list` gate leaves the agent with zero tools. Recent Qoder
 *    builds have started expanding `${workspaceFolder}` — but we can't
 *    detect the Qoder version at install time, and the moment a `--path`
 *    is set the MCP session skips the `roots/list` fallback entirely
 *    (see `session.ts` — `explicitProjectPath` short-circuits
 *    `initFromRoots`). Emitting `--path` would therefore break every
 *    older-Qoder user with a `NotIndexedError` on every tool call.
 *    Fix: install with NO `--path` at all — codegraph resolves the
 *    workspace via the MCP `roots/list` handshake (see
 *    `MCPSession.initFromRoots`) on every Qoder version, old and new,
 *    and falls back to `process.cwd()` if roots ever returns empty.
 *
 * 2. **Launched from Dock / launchd → no nvm PATH.** Qoder is Electron;
 *    macOS launches it without the login shell's PATH, so a `command: "codegraph"`
 *    that resolves fine in a terminal fails inside Qoder when codegraph
 *    is installed under nvm. Same problem antigravity hits — same fix:
 *    resolve to an absolute path at install time, via the user's login shell.
 *    (Linux GUI launchers vary; we don't special-case Linux here to stay
 *    consistent with antigravity's existing behavior, but nvm users on a
 *    stripped-PATH launcher may hit the same class of bug there too.)
 *
 * Docs: https://qoder.com/
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
  removeMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_INSTRUCTIONS_BODY,
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

/**
 * Directory Qoder stores its shared (across-project) settings under.
 * macOS uses the standard `~/Library/Application Support/Qoder`; other
 * platforms follow the Electron / VS-Code-fork convention (`$XDG_CONFIG_HOME`
 * on Linux, `%APPDATA%` on Windows) so a user with an existing Qoder
 * install has zero surprises.
 */
function qoderConfigDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Qoder');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Qoder');
  }
  // Linux / other POSIX
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'Qoder');
}

function mcpJsonPath(): string {
  return path.join(qoderConfigDir(), 'SharedClientCache', 'mcp.json');
}

/**
 * Project-scoped Qoder rule file we fully own. `.qoder/rules/*.md` has
 * higher precedence than project-root `AGENTS.md` in Qoder's own docs,
 * so this is the surface most likely to actually steer the agent.
 */
function qoderRulePath(): string {
  return path.join(process.cwd(), '.qoder', 'rules', 'codegraph.md');
}

/**
 * Legacy project-root `AGENTS.md` a pre-`.qoder/rules` build of this
 * target used to write into. Kept for self-heal on upgrade (both
 * install and uninstall strip any leftover CodeGraph fence from it).
 */
function legacyAgentsMdPath(): string {
  return path.join(process.cwd(), 'AGENTS.md');
}

/**
 * File body we write into `.qoder/rules/codegraph.md`. We own the
 * whole file (no marker fence), so a plain trailing newline is the
 * entire contract: byte-equal on subsequent installs = idempotent.
 */
function qoderRuleFileContents(): string {
  return CODEGRAPH_INSTRUCTIONS_BODY + '\n';
}

/**
 * macOS Qoder is launched by launchd / Dock, which strips PATH of any
 * nvm-managed entries — so a bare `codegraph` command fails to launch
 * from inside the app even when it works in every terminal. Resolve to
 * the login shell's `codegraph` at install time; that's the shell PATH
 * the user actually uses.
 *
 * Non-darwin returns the bare name — Linux launchers inherit the user
 * PATH, and Windows installs codegraph to a global location on PATH.
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
 * Build the codegraph MCP-server entry for Qoder. Deliberately NO
 * `--path` argument — see file header for why.
 */
function buildQoderEntry(): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: resolveCodegraphCommand(),
    args: ['serve', '--mcp'],
  };
}

class QoderTarget implements AgentTarget {
  readonly id = 'qoder' as const;
  readonly displayName = 'Qoder';
  readonly docsUrl = 'https://qoder.com/';

  supportsLocation(_loc: Location): boolean {
    // Global: shared user-scope `mcp.json` only. Local: shared
    // `mcp.json` + project-scoped `.qoder/rules/codegraph.md` rule
    // file (superset — matches the opencode / gemini / codex local
    // contract of "one command sets up this project end-to-end").
    return true;
  }

  detect(loc: Location): DetectionResult {
    if (loc === 'global') {
      const file = mcpJsonPath();
      const config = readJsonFile(file);
      const alreadyConfigured = !!config.mcpServers?.codegraph;
      const installed =
        fs.existsSync(qoderConfigDir()) || fs.existsSync(file);
      return { installed, alreadyConfigured, configPath: file };
    }
    // local — configured when the project owns `./.qoder/rules/codegraph.md`.
    // The MCP entry is user-scope and reflected via `global` detect;
    // mirroring it here would flip `alreadyConfigured` for every project
    // on the machine the moment any one of them was installed, breaking
    // the contract test that expects `uninstall local` to bring
    // `alreadyConfigured` back to false.
    const rule = qoderRulePath();
    const alreadyConfigured = fs.existsSync(rule);
    // Prefer Qoder's own config dir as the installedness signal — a
    // stray `.qoder/` in the project might have been made by Qoder's
    // cache without any actual codegraph configuration.
    const installed = fs.existsSync(qoderConfigDir()) || fs.existsSync(rule);
    return { installed, alreadyConfigured, configPath: rule };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc === 'global') {
      return {
        files: [writeMcpEntry()],
        notes: [
          'Restart Qoder for MCP changes to take effect.',
          'If codegraph tools do not appear after restart, verify the workspace was opened via Qoder (not via `cd` in a terminal) so Qoder emits an MCP `roots/list` notification — codegraph relies on that to find your project root, since Qoder does not substitute `${workspaceFolder}` in MCP args.',
          'For per-project agent nudging, run `codegraph install --target=qoder --location=local` inside each project — it writes a `.qoder/rules/codegraph.md` rule alongside the MCP entry so Qoder\'s agent proactively uses codegraph_explore.',
        ],
      };
    }
    // local — one-command onboarding: shared MCP + project-scoped
    // Qoder rule file. Matches how opencode / gemini / codex handle
    // local (a single call sets up everything the agent needs to
    // actually invoke codegraph in this project). Qoder has no
    // per-project mcp.json path, so the MCP entry naturally lands at
    // the shared user-scope location.
    // Order matters: write the Qoder-owned rule file first so it's
    // the visually leading artefact in --dry-run / verbose output —
    // it's the piece that's actually project-scoped and unique to
    // Qoder. The shared MCP entry that follows is user-scope and
    // identical to what a `--location=global` install would produce.
    const files: WriteResult['files'] = [];
    files.push(writeQoderRuleEntry());
    files.push(writeMcpEntry());

    // Self-heal: an older build of this target wrote a marker-fenced
    // CodeGraph section into `./AGENTS.md`. If it's still there,
    // strip it — `.qoder/rules/codegraph.md` has higher precedence and
    // the duplicated fence in AGENTS.md is just noise now.
    const legacyCleanup = removeLegacyAgentsMdFence();
    if (legacyCleanup) files.push(legacyCleanup);

    return {
      files,
      notes: [
        'Restart Qoder for MCP changes to take effect.',
        'Qoder has no project-local mcp.json — the MCP entry was written to the shared user-scope config; the `.qoder/rules/codegraph.md` rule is scoped to this project only.',
        'If your repo has `.qoder/` in .gitignore, teammates won\'t inherit this rule. Add a `!.qoder/rules/codegraph.md` exception (or share the rule via a top-level convention) if you want it committed.',
      ],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc === 'global') {
      const file = mcpJsonPath();
      const config = readJsonFile(file);
      if (config.mcpServers?.codegraph) {
        delete config.mcpServers.codegraph;
        if (Object.keys(config.mcpServers).length === 0) {
          delete config.mcpServers;
        }
        writeJsonFile(file, config);
        return { files: [{ path: file, action: 'removed' }] };
      }
      return { files: [{ path: file, action: 'not-found' }] };
    }
    // local — unlink `./.qoder/rules/codegraph.md` and sweep any
    // legacy `./AGENTS.md` fence. The shared MCP entry is user-scope
    // and other projects may depend on it; run `--location=global`
    // uninstall to remove the MCP entry itself.
    const files: WriteResult['files'] = [];
    files.push(removeQoderRuleEntry());
    const legacyCleanup = removeLegacyAgentsMdFence();
    if (legacyCleanup) files.push(legacyCleanup);
    return { files };
  }

  printConfig(loc: Location): string {
    const file = mcpJsonPath();
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildQoderEntry() } }, null, 2);
    if (loc === 'global') {
      return `# Add to ${file}\n\n${snippet}\n`;
    }
    // Print BOTH artefacts so a user following --print-config manually
    // ends up with the same on-disk state install would produce.
    // Symmetric with the local install() behaviour: rule file first,
    // MCP entry second.
    return [
      `# Write to ${qoderRulePath()} (Qoder auto-loads .qoder/rules/*.md; higher precedence than AGENTS.md):`,
      '',
      qoderRuleFileContents(),
      `# Add to ${file} (Qoder's shared user-scope MCP config — Qoder has no project-local mcp.json):`,
      '',
      snippet,
    ].join('\n');
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [mcpJsonPath()] : [qoderRulePath(), mcpJsonPath()];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpJsonPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildQoderEntry();

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
 * Write the `.qoder/rules/codegraph.md` file we fully own. Byte-equal
 * re-run reports `unchanged` so re-installs stay idempotent; a
 * different existing body (user hand-edit, older content shape) is
 * treated as `updated` and overwritten — this is a name we claim,
 * same policy Kiro's `steering/codegraph.md` used to enforce.
 */
function writeQoderRuleEntry(): WriteResult['files'][number] {
  const file = qoderRulePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const desired = qoderRuleFileContents();
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf-8');
    if (current === desired) return { path: file, action: 'unchanged' };
    fs.writeFileSync(file, desired);
    return { path: file, action: 'updated' };
  }
  fs.writeFileSync(file, desired);
  return { path: file, action: 'created' };
}

/**
 * Remove the `.qoder/rules/codegraph.md` we own. Filename is a name
 * we claim, so a partial-install leaving the file behind is worse
 * than a clean delete — mirrors kiro's old steering-file policy.
 */
function removeQoderRuleEntry(): WriteResult['files'][number] {
  const file = qoderRulePath();
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return { path: file, action: 'removed' };
}

/**
 * Strip a leftover CodeGraph marker fence from `./AGENTS.md` if a
 * pre-`.qoder/rules` build of this target wrote one there. Returns
 * the file action for reporting, or `null` when there's nothing to
 * clean up (no AGENTS.md, or no fence present). Called from both
 * install (self-heal on upgrade) and uninstall so the two paths
 * converge on the same clean state.
 */
function removeLegacyAgentsMdFence(): WriteResult['files'][number] | null {
  const md = legacyAgentsMdPath();
  if (!fs.existsSync(md)) return null;
  const action = removeMarkedSection(md, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  if (action === 'removed') return { path: md, action: 'removed' };
  return null;
}

export const qoderTarget: AgentTarget = new QoderTarget();
