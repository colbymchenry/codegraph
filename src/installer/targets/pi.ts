/**
 * Pi (pi-coding-agent) target.
 *
 *   - MCP server entry to `<agent-dir>/mcp.json` (global) or
 *     `<cwd>/.pi/mcp.json` (local). Same `{mcpServers: {...}}` shape as
 *     Claude / Cursor / Gemini.
 *   - Instructions to `<agent-dir>/AGENTS.md` (global) or
 *     `<cwd>/AGENTS.md` (local) — the context files Pi loads, which
 *     (unlike `.pi` project config) do not require project trust.
 *
 * ## Agent directory
 *
 * Pi's user config lives in the agent directory, which defaults to
 * `~/.pi/agent`. `PI_CODING_AGENT_DIR` overrides it, so we resolve the
 * same way Pi does — installing to the fallback while Pi reads the
 * override would be a silent no-op (the files get written and never
 * read), the same failure mode the Codex target guards against with
 * `CODEX_HOME` and the Copilot CLI with `COPILOT_HOME`.
 *
 * ## Why `exposure: "direct"`
 *
 * Pi defaults every MCP server to `codemode`: the server's tools are
 * callable from codemode scripts but are NOT declared to the model. The
 * CodeGraph instructions block tells the model to call
 * `codegraph_explore` by name, so the tool has to be declared — with
 * `direct` it joins the native tool list (and stays callable from
 * codemode as well). CodeGraph lists a single tool by default
 * (`codegraph_explore`), so there is no tool-list bloat to defend
 * against.
 *
 * No permissions concept — Pi gates every MCP call through its own tool
 * pipeline (extension permission gates) rather than an
 * installer-populated allowlist. `autoAllow` is silently ignored.
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

/**
 * Pi's user config directory. Defaults to `~/.pi/agent`; the env var is
 * Pi's documented override (docs/configuration.md#agent-directory).
 */
function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.pi', 'agent');
}

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(agentDir(), 'mcp.json')
    : path.join(process.cwd(), '.pi', 'mcp.json');
}

function instructionsPath(loc: Location): string {
  // Global AGENTS.md lives in the agent directory; project-local
  // AGENTS.md lives at the project root (NOT under `.pi/`) — that's the
  // file Pi's context-file discovery reads.
  return loc === 'global'
    ? path.join(agentDir(), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

/**
 * CodeGraph MCP entry as Pi wants it. Inherits the shared stdio shape
 * ({type, command, args}) and adds `exposure: "direct"` so
 * `codegraph_explore` is declared to the model instead of only being
 * reachable from codemode scripts. See the file header.
 */
function buildPiMcpConfig(): {
  type: string;
  command: string;
  args: string[];
  exposure: string;
} {
  return { ...getMcpServerConfig(), exposure: 'direct' };
}

class PiTarget implements AgentTarget {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi';
  readonly docsUrl = 'https://github.com/earendil-works/pi';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // "Installed" heuristic: the agent directory exists (global), or the
    // project has opted into a `.pi/` dir (local). Pi's own mcp.json
    // counts too, so first-run installs are detected.
    const installed = loc === 'global'
      ? fs.existsSync(agentDir()) || fs.existsSync(path.join(os.homedir(), '.pi'))
      : fs.existsSync(path.join(process.cwd(), '.pi'));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return {
      files,
      notes: ['Restart Pi or run /reload so the MCP server is picked up.'],
    };
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
      // Leave a now-empty `{}` in place — other top-level Pi config the
      // user adds later can share the file.
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
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildPiMcpConfig() } }, null, 2);
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
  const after = buildPiMcpConfig();

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

export const piTarget: AgentTarget = new PiTarget();
