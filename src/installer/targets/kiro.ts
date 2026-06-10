/**
 * Kiro CLI / IDE target. Writes:
 *
 *   - MCP server entry to `~/.kiro/settings/mcp.json` (global) or
 *     `./.kiro/settings/mcp.json` (local). Standard `mcpServers.codegraph`
 *     shape, same as Claude / Cursor / Gemini.
 *   - Instructions to `~/.kiro/steering/codegraph.md` (global) or
 *     `./.kiro/steering/codegraph.md` (local). Kiro's "steering" system
 *     loads every `*.md` file in the steering dir as agent context, so
 *     a dedicated `codegraph.md` is the natural surface — we own the
 *     whole file outright (no marker-based merging needed) and delete
 *     it on uninstall.
 *
 * No permissions concept — Kiro gates tool invocations through its own
 * UI prompts rather than an external allowlist. `autoAllow` is silently
 * ignored.
 *
 * Paths are identical on macOS / Linux / Windows because Kiro resolves
 * its config root from `os.homedir()` on all three (Windows `~` →
 * `%USERPROFILE%\.kiro`).
 *
 * Docs: https://kiro.dev/docs/cli/mcp/
 *       https://kiro.dev/docs/cli/steering/
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
  writeJsonFile,
} from './shared';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.kiro')
    : path.join(process.cwd(), '.kiro');
}
function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings', 'mcp.json');
}
function steeringPath(loc: Location): string {
  return path.join(configDir(loc), 'steering', 'codegraph.md');
}

class KiroTarget implements AgentTarget {
  readonly id = 'kiro' as const;
  readonly displayName = 'Kiro';
  readonly docsUrl = 'https://kiro.dev/docs/cli/mcp/';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(configDir('global')) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // The steering doc is no longer written — the codegraph usage
    // guidance ships in the MCP server's `initialize` response (issue
    // #529). Delete a `codegraph.md` a previous install created so an
    // upgrade self-heals.
    const steeringCleanup = removeSteeringEntry(loc);
    if (steeringCleanup.action === 'removed') files.push(steeringCleanup);

    return {
      files,
      // The IDE-only enable-MCP step is load-bearing: Kiro IDE ships
      // with MCP support disabled by default, so even a valid
      // `~/.kiro/settings/mcp.json` at the documented path is ignored
      // until the user flips the toggle. Kiro CLI reads the same file
      // without a gate, so we call out which audience this applies to.
      notes: [
        'Restart Kiro for MCP changes to take effect.',
        'Kiro IDE: also enable MCP in Settings (search "MCP" → "Enabled"). Kiro CLI users can skip this step.',
      ],
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
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(removeSteeringEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), steeringPath(loc)];
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
 * Delete the steering file we own. If a user has hand-edited the file
 * out of recognition we still remove it — codegraph.md is a name we
 * claim, and a partial install leaving the file behind is worse than
 * a clean delete. Used by both install (self-heal on upgrade — see
 * issue #529) and uninstall.
 */
function removeSteeringEntry(loc: Location): WriteResult['files'][number] {
  const file = steeringPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return { path: file, action: 'removed' };
}

export const kiroTarget: AgentTarget = new KiroTarget();
