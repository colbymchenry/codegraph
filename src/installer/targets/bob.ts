/**
 * IBM Bob target (Bob IDE and Bob Shell, which read the same files). Writes
 * the MCP server entry only:
 *
 *   - global: `~/.bob/settings/mcp.json`
 *   - local:  `./.bob/mcp.json`, which Bob means to be shared in the repo
 *
 * The entry is `{ command, args }` under `mcpServers`: Bob's stdio entry has
 * no `type` key. IBM's watsonx.data guide calls the global file
 * `mcp_settings.json`, so when only that file exists, it is the one used.
 *
 * No instructions file, and `autoAllow` is a no-op: Bob approves MCP tools one
 * by one, behind its own global "Use MCP servers" switch.
 *
 * Docs: https://bob.ibm.com/docs/ide/configuration/mcp/mcp-in-bob
 *       https://bob.ibm.com/docs/shell/configuration/mcp/mcp-bobshell
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import { hasCodegraphServer, removeCodegraphServer, upsertCodegraphServer } from './json-config';
import { getStdioServerConfig } from './shared';

function configDir(loc: Location): string {
  return path.join(loc === 'global' ? os.homedir() : process.cwd(), '.bob');
}

function mcpJsonPath(loc: Location): string {
  if (loc === 'local') return path.join(configDir('local'), 'mcp.json');
  const settings = path.join(configDir('global'), 'settings');
  const current = path.join(settings, 'mcp.json');
  const earlier = path.join(settings, 'mcp_settings.json');
  return !fs.existsSync(current) && fs.existsSync(earlier) ? earlier : current;
}

class BobTarget implements AgentTarget {
  readonly id = 'bob' as const;
  readonly displayName = 'IBM Bob';
  readonly docsUrl = 'https://bob.ibm.com/docs/ide/configuration/mcp/mcp-in-bob';

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
    return { files: [upsertCodegraphServer(mcpJsonPath(loc), getStdioServerConfig())] };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeCodegraphServer(mcpJsonPath(loc))] };
  }

  printConfig(loc: Location): string {
    const snippet = JSON.stringify({ mcpServers: { codegraph: getStdioServerConfig() } }, null, 2);
    return `# Add to ${mcpJsonPath(loc)}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

export const bobTarget: AgentTarget = new BobTarget();
