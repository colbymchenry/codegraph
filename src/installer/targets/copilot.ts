/**
 * GitHub Copilot CLI target.
 *
 *   - MCP server entry to `~/.copilot/mcp-config.json` (global only).
 *   - Instructions to `~/.copilot/AGENTS.md`.
 *
 * Copilot CLI as of 2026-05 has no project-local config concept —
 * everything lives under `~/.copilot/`. `supportsLocation('local')`
 * returns false; the orchestrator skips Copilot when the user picks
 * the local install location.
 *
 * No permissions concept (uses runtime `--allow-tool` flags).
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
  replaceOrAppendMarkedSection,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
  INSTRUCTIONS_TEMPLATE,
} from '../instructions-template';

function configDir(): string {
  return path.join(os.homedir(), '.copilot');
}
function mcpConfigPath(): string {
  return path.join(configDir(), 'mcp-config.json');
}
function instructionsPath(): string {
  return path.join(configDir(), 'AGENTS.md');
}

class CopilotTarget implements AgentTarget {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly docsUrl = 'https://docs.github.com/copilot/using-github-copilot/using-github-copilot-in-the-command-line';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const mcpPath = mcpConfigPath();
    let alreadyConfigured = false;
    if (fs.existsSync(mcpPath)) {
      try {
        const config = readJsonFile(mcpPath);
        alreadyConfigured = !!config.mcpServers?.codegraph;
      } catch { /* ignore */ }
    }
    const installed = fs.existsSync(configDir());
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Copilot CLI has no project-local config — re-run with --location=global to install.'],
      };
    }
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry());
    files.push(writeInstructionsEntry());

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    const mcpPath = mcpConfigPath();
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 2. Instructions
    const instr = instructionsPath();
    const action = removeMarkedSection(instr, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    files.push({ path: instr, action });

    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Copilot CLI has no project-local config — use --location=global.\n';
    }
    const target = mcpConfigPath();
    const mcp = getMcpServerConfig();
    // Copilot-specific: add "type" and "tools" fields
    const copilotEntry = {
      type: 'local',
      command: mcp.command,
      args: mcp.args,
      tools: ['*'],
    };
    const snippet = JSON.stringify({ mcpServers: { codegraph: copilotEntry } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [mcpConfigPath(), instructionsPath()];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = mcpConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const baseMcp = getMcpServerConfig();
  
  // Copilot-specific: add "type" and "tools" fields
  const after = {
    type: 'local',
    command: baseMcp.command,
    args: baseMcp.args,
    tools: ['*'],
  };

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  const created = !fs.existsSync(file);
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action: created ? 'created' : 'updated' };
}

function writeInstructionsEntry(): WriteResult['files'][number] {
  const file = instructionsPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const action = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created'
      : action === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
}

export const copilotTarget: AgentTarget = new CopilotTarget();
