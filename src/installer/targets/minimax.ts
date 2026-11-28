/**
 * MiniMax Code target, global only.
 *
 *   - MCP server entry under `mcpServers` in `mcp.json` in `$MINIMAX_DATA_DIR`
 *     (default `~/.minimax`). An entry with `command` and no `type` is a stdio
 *     server.
 *   - Instructions to `AGENTS.md` in the same directory, which MiniMax Code
 *     adds to every session.
 *
 * Its only project-level MCP file is `.mcp.json`, which is Claude Code's local
 * config too, so an uninstall here would take the server away from Claude.
 * `supportsLocation('local')` is false. `autoAllow` is a no-op.
 *
 * Docs: https://www.npmjs.com/package/@minimax-ai/code
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import { hasCodegraphServer, removeCodegraphServer, upsertCodegraphServer } from './json-config';
import {
  configDirFromEnv,
  getStdioServerConfig,
  removeInstructionsEntry,
  upsertInstructionsEntry,
} from './shared';

function configDir(): string {
  return configDirFromEnv('MINIMAX_DATA_DIR', path.join(os.homedir(), '.minimax'));
}

function mcpJsonPath(): string {
  return path.join(configDir(), 'mcp.json');
}

function instructionsPath(): string {
  return path.join(configDir(), 'AGENTS.md');
}

class MinimaxTarget implements AgentTarget {
  readonly id = 'minimax' as const;
  readonly displayName = 'MiniMax Code';
  readonly docsUrl = 'https://www.npmjs.com/package/@minimax-ai/code';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') return { installed: false, alreadyConfigured: false };
    const file = mcpJsonPath();
    return {
      installed: fs.existsSync(configDir()),
      alreadyConfigured: hasCodegraphServer(file),
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return { files: [], notes: ['MiniMax Code has no project-local config of its own — re-run with --location=global.'] };
    }
    return {
      files: [
        upsertCodegraphServer(mcpJsonPath(), getStdioServerConfig()),
        upsertInstructionsEntry(instructionsPath()),
      ],
      notes: ['Restart MiniMax Code to load CodeGraph.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    return {
      files: [
        removeCodegraphServer(mcpJsonPath()),
        removeInstructionsEntry(instructionsPath()),
      ],
    };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') return '# MiniMax Code has no project-local config of its own — use --location=global.\n';
    const snippet = JSON.stringify({ mcpServers: { codegraph: getStdioServerConfig() } }, null, 2);
    return `# Add to ${mcpJsonPath()}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [mcpJsonPath(), instructionsPath()] : [];
  }
}

export const minimaxTarget: AgentTarget = new MinimaxTarget();
