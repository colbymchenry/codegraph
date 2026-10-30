/**
 * Windsurf target, global only: MCP server entry under `mcpServers` in
 * `~/.codeium/windsurf/mcp_config.json`.
 *
 * Windsurf became Devin Desktop in June 2026. That file is the stable channel's
 * MCP config, and Devin imports it: `read_config_from.windsurf` is on unless the
 * user turns it off. Devin's own `~/.config/devin/mcp_config.json` belongs to
 * a Devin target, not this one. Windsurf documents no project-local MCP file, so
 * `supportsLocation('local')` is false.
 *
 * The entry is `{ command, args }`, with no `type` key, as in Windsurf's docs.
 * No instructions file: the only per-user rules file it documented,
 * `global_rules.md`, belonged to Cascade, which Devin Desktop removed in
 * September 2026. `autoAllow` is a no-op: tools are approved in the app.
 *
 * Docs: https://docs.devin.ai/cli/reference/configuration/read-config-from
 *       https://docs.devin.ai/windsurf/plugins/cascade/mcp
 *       https://docs.devin.ai/desktop/devin-desktop-faq
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import { hasCodegraphServer, removeCodegraphServer, upsertCodegraphServer } from './json-config';
import { getStdioServerConfig } from './shared';

function configDir(): string {
  return path.join(os.homedir(), '.codeium', 'windsurf');
}

function mcpConfigPath(): string {
  return path.join(configDir(), 'mcp_config.json');
}

class WindsurfTarget implements AgentTarget {
  readonly id = 'windsurf' as const;
  readonly displayName = 'Windsurf';
  readonly docsUrl = 'https://docs.windsurf.com/windsurf/cascade/mcp';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') return { installed: false, alreadyConfigured: false };
    const file = mcpConfigPath();
    return {
      installed: fs.existsSync(configDir()),
      alreadyConfigured: hasCodegraphServer(file),
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return { files: [], notes: ['Windsurf has no project-local MCP config — re-run with --location=global.'] };
    }
    return {
      files: [upsertCodegraphServer(mcpConfigPath(), getStdioServerConfig())],
      notes: ['Restart Windsurf, or refresh its MCP list, to load CodeGraph.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    return { files: [removeCodegraphServer(mcpConfigPath())] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') return '# Windsurf has no project-local MCP config — use --location=global.\n';
    const snippet = JSON.stringify({ mcpServers: { codegraph: getStdioServerConfig() } }, null, 2);
    return `# Add to ${mcpConfigPath()}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [mcpConfigPath()] : [];
  }
}

export const windsurfTarget: AgentTarget = new WindsurfTarget();
