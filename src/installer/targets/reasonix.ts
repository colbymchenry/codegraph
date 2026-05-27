/**
 * Reasonix target.
 *
 * Reasonix stores MCP server config in `~/.reasonix/config.json`
 * (global) or `./.reasonix/config.json` (local). The `mcp` key is a
 * **string array** where each entry is `"name=command args..."`:
 *
 *   { "mcp": ["filesystem=npx -y @modelcontextprotocol/server-filesystem /path", "codegraph=codegraph serve --mcp"] }
 *
 * Instructions go into `~/.reasonix/REASONIX.md` (global) or
 * `./REASONIX.md` (local) with the standard marker-delimited section.
 *
 * No permissions concept — autoAllow is silently ignored.
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

/** The MCP entry string for codegraph in Reasonix's array format. */
export const CODEGRAPH_MCP_ENTRY = 'codegraph=codegraph serve --mcp';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.reasonix')
    : path.join(process.cwd(), '.reasonix');
}

function configPath(loc: Location): string {
  return path.join(configDir(loc), 'config.json');
}

function instructionsPath(loc: Location): string {
  // Global REASONIX.md lives under ~/.reasonix/; project-local
  // REASONIX.md lives at the project root (NOT under .reasonix/).
  return loc === 'global'
    ? path.join(configDir('global'), 'REASONIX.md')
    : path.join(process.cwd(), 'REASONIX.md');
}

/**
 * Find the index of the codegraph entry in the `mcp` string array.
 * Each entry is `"name=..."` — we look for the one starting with
 * `"codegraph="`.
 */
function findCodegraphIndex(config: Record<string, any>): number {
  const mcp = config.mcp;
  if (!Array.isArray(mcp)) return -1;
  return mcp.findIndex((entry: any) => typeof entry === 'string' && entry.startsWith('codegraph='));
}

/**
 * Check if a codegraph entry already exists and matches our canonical form.
 */
function hasCanonicalEntry(config: Record<string, any>): boolean {
  const idx = findCodegraphIndex(config);
  if (idx === -1) return false;
  return config.mcp[idx] === CODEGRAPH_MCP_ENTRY;
}

class ReasonixTarget implements AgentTarget {
  readonly id = 'reasonix' as const;
  readonly displayName = 'Reasonix';
  readonly docsUrl = 'https://reasonix.dev';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = findCodegraphIndex(config) !== -1;
    const installed = loc === 'global'
      ? fs.existsSync(configDir('global')) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    files.push(writeInstructionsEntry(loc));
    return {
      files,
      notes: ['Restart Reasonix for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(removeMcpEntry(loc));

    const instr = instructionsPath(loc);
    const action = removeMarkedSection(instr, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    files.push({ path: instr, action });

    return { files };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify({ mcp: [CODEGRAPH_MCP_ENTRY] }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const config = readJsonFile(file);

  if (hasCanonicalEntry(config)) {
    return { path: file, action: 'unchanged' };
  }

  const action: 'created' | 'updated' =
    findCodegraphIndex(config) !== -1 ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');

  if (!Array.isArray(config.mcp)) {
    config.mcp = [];
  }

  const idx = findCodegraphIndex(config);
  if (idx !== -1) {
    config.mcp[idx] = CODEGRAPH_MCP_ENTRY;
  } else {
    config.mcp.push(CODEGRAPH_MCP_ENTRY);
  }

  writeJsonFile(file, config);
  return { path: file, action };
}

function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
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

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  const config = readJsonFile(file);
  const idx = findCodegraphIndex(config);
  if (idx === -1) return { path: file, action: 'not-found' };

  config.mcp.splice(idx, 1);
  if (config.mcp.length === 0) {
    delete config.mcp;
  }
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const reasonixTarget: AgentTarget = new ReasonixTarget();
