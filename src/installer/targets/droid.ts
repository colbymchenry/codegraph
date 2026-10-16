/**
 * Factory Droid target (Droid CLI / Factory App).
 *
 *   - MCP server entry to `mcp.json` under the standard
 *     `mcpServers.codegraph` key — plain JSON, same shape as Claude /
 *     Cursor / Gemini. Droid reads three levels (user / folder /
 *     project); we write the user and project layers:
 *       - global: `~/.factory/mcp.json`
 *       - local:  `<cwd>/.factory/mcp.json`
 *   - Instructions to `AGENTS.md`:
 *       - global: `~/.factory/AGENTS.md`
 *       - local:  `<cwd>/AGENTS.md` (the project-root file Droid's
 *         docs recommend; it also reads `.factory/AGENTS.md` and the
 *         CLAUDE.md compatibility names, but root AGENTS.md is the
 *         canonical surface — and the same file the codex target
 *         writes, so a repo configured for both shares one
 *         marker-fenced block, made byte-identical by the upsert).
 *
 * Two Droid behaviors shape this target:
 *
 *   - Droid reloads automatically when an `mcp.json` file changes, so
 *     no "restart your agent" note — the server is available in the
 *     next session (and usually the current one).
 *   - The project-level `.factory/mcp.json` is designed to be
 *     committed (team-shared servers), so a local install is a diff
 *     the user is expected to check in. No secrets ever go there —
 *     our entry is a stdio command, which carries none.
 *
 * No permissions concept: Droid remembers MCP tool approvals per
 * server-config fingerprint (`droid mcp permissions`) rather than a
 * settings.json allowlist, so `autoAllow` is a no-op here, and there
 * is no prompt-hook surface either.
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
  getMcpServerConfig,
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

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.factory')
    : path.join(process.cwd(), '.factory');
}
function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}
function instructionsPath(loc: Location): string {
  // Global AGENTS.md lives under ~/.factory/; project-local AGENTS.md
  // lives at the project root (NOT under .factory/), matching how
  // Droid's instruction loader searches and the convention the codex
  // and gemini targets already use.
  return loc === 'global'
    ? path.join(configDir('global'), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

/**
 * The project-level file is meant to be committed — say so, so a
 * local install doesn't read as a private-machine-only change.
 */
function commitNote(): string {
  return `Droid shares ${mcpJsonPath('local')} with the team — it is designed to be committed to the repo.`;
}

class DroidTarget implements AgentTarget {
  readonly id = 'droid' as const;
  readonly displayName = 'Factory Droid';
  readonly docsUrl = 'https://docs.factory.ai/droid-cli/overview';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // Global: ~/.factory/ existing means Droid has run here. Local: the
    // project only counts once it has a .factory/ dir of its own.
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return loc === 'local' ? { files, notes: [commitNote()] } : { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      // If the file is now an empty `{}` we still leave it — other
      // (top-level) Droid settings the user might add later can share
      // the file; deleting it would be surprising.
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

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
 * Strip the marker-delimited CodeGraph block from AGENTS.md if a prior
 * install wrote one. Used by both install (self-heal on upgrade) and
 * uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const droidTarget: AgentTarget = new DroidTarget();
