/**
 * Kimi Code target.
 *
 *   - MCP server entry under `mcpServers` in `mcp.json`: `$KIMI_CODE_HOME`
 *     (default `~/.kimi-code`) when global, `./.kimi-code` when local. Kimi
 *     reads an entry with `command` as a stdio server and documents no `type`
 *     key. A project-level server runs only once the folder is trusted, so a
 *     local install says so.
 *   - Instructions to `AGENTS.md`: in `$KIMI_CODE_HOME` when global, at the
 *     project root when local.
 *
 * `autoAllow` is a no-op: Kimi keeps its approval rules in its own
 * `config.toml`, as `[[permission.rules]]`.
 *
 * Docs: https://moonshotai.github.io/kimi-code/en/customization/mcp.html
 *       https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html
 *       https://moonshotai.github.io/kimi-code/en/customization/agents.html
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

function configDir(loc: Location): string {
  return loc === 'global'
    ? configDirFromEnv('KIMI_CODE_HOME', path.join(os.homedir(), '.kimi-code'))
    : path.join(process.cwd(), '.kimi-code');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function instructionsPath(loc: Location): string {
  return loc === 'global' ? path.join(configDir('global'), 'AGENTS.md') : path.join(process.cwd(), 'AGENTS.md');
}

class KimiTarget implements AgentTarget {
  readonly id = 'kimi' as const;
  readonly displayName = 'Kimi Code';
  readonly docsUrl = 'https://moonshotai.github.io/kimi-code/en/customization/mcp.html';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    return {
      installed: fs.existsSync(configDir(loc)),
      alreadyConfigured: hasCodegraphServer(file),
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const notes = ['Start a new Kimi Code session: a server added mid-session only joins later ones.'];
    if (loc === 'local') notes.push(`Kimi Code runs ${mcpJsonPath('local')} only in a trusted folder: trust this folder when Kimi Code asks.`);
    return {
      files: [
        upsertCodegraphServer(mcpJsonPath(loc), getStdioServerConfig()),
        upsertInstructionsEntry(instructionsPath(loc)),
      ],
      notes,
    };
  }

  uninstall(loc: Location): WriteResult {
    return {
      files: [
        removeCodegraphServer(mcpJsonPath(loc)),
        removeInstructionsEntry(instructionsPath(loc)),
      ],
    };
  }

  printConfig(loc: Location): string {
    const snippet = JSON.stringify({ mcpServers: { codegraph: getStdioServerConfig() } }, null, 2);
    return `# Add to ${mcpJsonPath(loc)}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), instructionsPath(loc)];
  }
}

export const kimiTarget: AgentTarget = new KimiTarget();
