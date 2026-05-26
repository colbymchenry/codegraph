/**
 * Antigravity IDE target.
 *
 * Installs CodeGraph as an Antigravity Plugin, enabling support for
 * both global (`~/.gemini/config/plugins/codegraph/`) and local 
 * (`./.agents/plugins/codegraph/`) deployments.
 *
 * The plugin bundles:
 *   - `plugin.json`
 *   - `mcp_config.json`
 *   - `skills/codegraph-instructions/SKILL.md` (Agent instructions)
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
import {
  INSTRUCTIONS_TEMPLATE,
} from '../instructions-template';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.gemini', 'config', 'plugins', 'codegraph')
    : path.join(process.cwd(), '.agents', 'plugins', 'codegraph');
}

function pluginJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'plugin.json');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp_config.json');
}

function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'skills', 'codegraph-instructions', 'SKILL.md');
}

function rulesPath(loc: Location): string {
  return path.join(configDir(loc), 'rules', 'codegraph-rules.md');
}

class AntigravityTarget implements AgentTarget {
  readonly id = 'antigravity' as const;
  readonly displayName = 'Antigravity IDE';
  readonly docsUrl = '';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const dir = configDir(loc);
    const installed = fs.existsSync(dir);
    return { installed, alreadyConfigured: installed, configPath: dir };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // Cleanup legacy files from earlier flawed global install
    if (loc === 'global') {
      const legacyCleanup = cleanupLegacyFiles();
      files.push(...legacyCleanup);
    }

    files.push(writePluginJson(loc));
    files.push(writeMcpEntry(loc));
    files.push(writeInstructionsEntry(loc));
    files.push(writeRulesEntry(loc));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const dir = configDir(loc);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        files.push({ path: dir, action: 'removed' });
      } catch {
        // Ignore removal errors
      }
    } else {
      files.push({ path: dir, action: 'not-found' });
    }

    if (loc === 'global') {
      const legacyCleanup = cleanupLegacyFiles();
      files.push(...legacyCleanup);
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configDir(loc)];
  }
}

function writePluginJson(loc: Location): WriteResult['files'][number] {
  const file = pluginJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = fs.existsSync(file) ? readJsonFile(file) : null;
  const after = { name: 'codegraph', description: 'CodeGraph Semantic Code Intelligence' };

  if (existing && jsonDeepEqual(existing, after)) {
    return { path: file, action: 'unchanged' };
  }

  writeJsonFile(file, after);
  return { path: file, action: existing ? 'updated' : 'created' };
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = fs.existsSync(file) ? readJsonFile(file) : null;
  const after = { mcpServers: { codegraph: getMcpServerConfig() } };

  if (existing && jsonDeepEqual(existing, after)) {
    return { path: file, action: 'unchanged' };
  }

  writeJsonFile(file, after);
  return { path: file, action: existing ? 'updated' : 'created' };
}

function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SKILL_CONTENT = `---
name: codegraph-instructions
description: Explains how to use the CodeGraph MCP server for semantic code intelligence, codebase graph queries, finding references, and understanding architecture. Use this whenever the codegraph_* tools are available or the user asks questions about code structure.
---

${INSTRUCTIONS_TEMPLATE}
`;

  let action: 'created' | 'updated' | 'unchanged' = 'created';
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf-8');
    if (existing === SKILL_CONTENT) {
      action = 'unchanged';
    } else {
      action = 'updated';
    }
  }

  if (action !== 'unchanged') {
    fs.writeFileSync(file, SKILL_CONTENT, 'utf-8');
  }

  return { path: file, action };
}

function writeRulesEntry(loc: Location): WriteResult['files'][number] {
  const file = rulesPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const RULE_CONTENT = `---
name: codegraph-rules
description: Defines when to use CodeGraph over native grep search.
trigger: always_on
---

${INSTRUCTIONS_TEMPLATE}
`;

  let action: 'created' | 'updated' | 'unchanged' = 'created';
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf-8');
    if (existing === RULE_CONTENT) {
      action = 'unchanged';
    } else {
      action = 'updated';
    }
  }

  if (action !== 'unchanged') {
    fs.writeFileSync(file, RULE_CONTENT, 'utf-8');
  }

  return { path: file, action };
}

function cleanupLegacyFiles(): WriteResult['files'] {
  const files: WriteResult['files'] = [];

  // Cleanup wrong mcp config file
  const oldMcpPath = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
  if (fs.existsSync(oldMcpPath)) {
    try {
      const config = readJsonFile(oldMcpPath);
      if (config?.mcpServers?.codegraph) {
        delete config.mcpServers.codegraph;
        if (Object.keys(config.mcpServers).length === 0) {
          delete config.mcpServers;
        }
        writeJsonFile(oldMcpPath, config);
        files.push({ path: oldMcpPath, action: 'updated' });
      }
    } catch {
      // ignore
    }
  }

  // Cleanup wrong instructions file
  const oldInstrDir = path.join(os.homedir(), '.gemini', 'antigravity-ide', 'mcp', 'codegraph');
  const oldInstr = path.join(oldInstrDir, 'instructions.md');
  if (fs.existsSync(oldInstr)) {
    try {
      fs.unlinkSync(oldInstr);
      files.push({ path: oldInstr, action: 'removed' });
      
      // Cleanup empty dirs up to .gemini/antigravity-ide
      if (fs.readdirSync(oldInstrDir).length === 0) fs.rmdirSync(oldInstrDir);
      const parentDir = path.dirname(oldInstrDir);
      if (fs.readdirSync(parentDir).length === 0) fs.rmdirSync(parentDir);
    } catch {
      // ignore
    }
  }

  return files;
}

export const antigravityTarget: AgentTarget = new AntigravityTarget();
