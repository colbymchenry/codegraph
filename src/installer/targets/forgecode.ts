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
  atomicWriteFileSync,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';
import { INSTRUCTIONS_TEMPLATE } from '../instructions-template';

function configDir(loc: Location): string {
  const targetPath = loc === 'local'
    ? path.join(process.cwd(), 'forgecode.forge/skills'.replace(/\/skills$/, ''))
    : path.join(os.homedir(), '~/.forge/skills'.replace(/^~\//, '').replace(/\/skills$/, ''));
  return targetPath;
}

function skillsDir(loc: Location): string {
  return loc === 'local'
    ? path.join(process.cwd(), 'forgecode.forge/skills')
    : path.join(os.homedir(), '~/.forge/skills'.replace(/^~\//, ''));
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function steeringPath(loc: Location): string {
  return path.join(skillsDir(loc), 'codegraph.md');
}

class ForgecodeTarget implements AgentTarget {
  readonly id = 'forgecode' as const;
  readonly displayName = 'ForgeCode';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    const installed = fs.existsSync(skillsDir(loc)) || fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    files.push(writeSteeringEntry(loc));
    return {
      files,
      notes: [
        'Restart ForgeCode for MCP changes to take effect.'
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

  printConfig(_loc: Location): string {
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return snippet;
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

function writeSteeringEntry(loc: Location): WriteResult['files'][number] {
  const file = steeringPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const body = INSTRUCTIONS_TEMPLATE + '\n';

  if (!fs.existsSync(file)) {
    atomicWriteFileSync(file, body);
    return { path: file, action: 'created' };
  }
  const existing = fs.readFileSync(file, 'utf-8');
  if (existing === body) {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, body);
  return { path: file, action: 'updated' };
}

function removeSteeringEntry(loc: Location): WriteResult['files'][number] {
  const file = steeringPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return { path: file, action: 'removed' };
}

export const forgecodeTarget: AgentTarget = new ForgecodeTarget();
