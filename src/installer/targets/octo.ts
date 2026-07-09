/**
 * octo (octo-agent) target.
 *
 *   - MCP server entry to `~/.octo/mcp.json` (global) or
 *     `./.octo/mcp.json` (local) under the standard `mcpServers.codegraph`
 *     key. The shape is the same one Claude Code / Cursor / Gemini use,
 *     so users can copy-paste configs between octo and other agents.
 *
 *   - Project instructions are upserted into `~/.octo/octorules.md`
 *     (global) or `./.octo/octorules.md` (local) using the same
 *     marker-fenced CodeGraph section that Claude / Codex / Gemini use,
 *     because octo loads these rules into every session's system prompt.
 *
 *   - No permissions concept — octo gates tool invocations through its
 *     own permission-mode system, not an external allowlist. `autoAllow`
 *     is silently ignored.
 *
 * Docs: https://octo-agent.dev/docs/guides/connect-mcp-servers
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CODEGRAPH_INSTRUCTIONS_BLOCK,
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
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
  upsertInstructionsEntry,
  writeJsonFile,
} from './shared';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.octo')
    : path.join(process.cwd(), '.octo');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function octorulesPath(loc: Location): string {
  return path.join(configDir(loc), 'octorules.md');
}

class OctoTarget implements AgentTarget {
  readonly id = 'octo' as const;
  readonly displayName = 'octo';
  readonly docsUrl = 'https://octo-agent.dev/docs/guides/connect-mcp-servers';

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
    files.push(upsertInstructionsEntry(octorulesPath(loc)));
    return { files };
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

    const rulesFile = octorulesPath(loc);
    const instructionsAction = removeMarkedSection(
      rulesFile,
      CODEGRAPH_SECTION_START,
      CODEGRAPH_SECTION_END,
    );
    files.push({ path: rulesFile, action: instructionsAction });

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n\n# Add to ${octorulesPath(loc)}\n\n${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), octorulesPath(loc)];
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

export const octoTarget: AgentTarget = new OctoTarget();
