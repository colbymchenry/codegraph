/**
 * IBM Bob target.
 *
 *   - MCP server entry to `~/.bob/mcp_settings.json` (global) or
 *     `./.bob/mcp.json` (local). Uses the standard
 *     `{ mcpServers: { codegraph: {...} } }` shape, same as Claude
 *     and Cursor.
 *   - Instructions to `~/.bob/AGENTS.md` (global) or
 *     `./.bob/AGENTS.md` (local).
 *   - No permissions concept — Bob doesn't expose an auto-allow list
 *     the installer can populate. `autoAllow` is silently ignored.
 *
 * Config shape:
 *   {
 *     "mcpServers": {
 *       "codegraph": { "type": "stdio", "command": "codegraph", "args": ["serve", "--mcp"] }
 *     }
 *   }
 *
 * Docs: https://bob.ibm.com/docs/ide/configuration/mcp/mcp-in-bob
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

function mcpConfigPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.bob', 'mcp_settings.json')
    : path.join(process.cwd(), '.bob', 'mcp.json');
}

function instructionsPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.bob', 'AGENTS.md')
    : path.join(process.cwd(), '.bob', 'AGENTS.md');
}

class BobTarget implements AgentTarget {
  readonly id = 'ibm-bob' as const;
  readonly displayName = 'IBM Bob';
  readonly docsUrl = 'https://bob.ibm.com/docs/ide/configuration/mcp/mcp-in-bob';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const cfgPath = mcpConfigPath(loc);
    const config = readJsonFile(cfgPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = loc === 'global'
      ? fs.existsSync(path.join(os.homedir(), '.bob'))
      : fs.existsSync(path.join(process.cwd(), '.bob'));
    return { installed, alreadyConfigured, configPath: cfgPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc), writeInstructionsEntry(loc)],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const cfgPath = mcpConfigPath(loc);
    const config = readJsonFile(cfgPath);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(cfgPath, config);
      files.push({ path: cfgPath, action: 'removed' });
    } else {
      files.push({ path: cfgPath, action: 'not-found' });
    }

    const instr = instructionsPath(loc);
    const instrAction = removeMarkedSection(instr, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    files.push({ path: instr, action: instrAction });

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpConfigPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpConfigPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpConfigPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  const action: 'created' | 'updated' = fs.existsSync(file) ? 'updated' : 'created';
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const result = replaceOrAppendMarkedSection(
    file,
    INSTRUCTIONS_TEMPLATE,
    CODEGRAPH_SECTION_START,
    CODEGRAPH_SECTION_END,
  );
  const mapped: 'created' | 'updated' | 'unchanged' =
    result === 'created' ? 'created'
      : result === 'unchanged' ? 'unchanged'
        : 'updated';
  return { path: file, action: mapped };
}

export const bobTarget: AgentTarget = new BobTarget();