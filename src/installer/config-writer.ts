/**
 * Config file writing for the CodeGraph installer
 * Writes to claude.json, settings.json, and CLAUDE.md
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { InstallLocation } from './prompts';
import {
  CLAUDE_MD_TEMPLATE,
  CODEGRAPH_SECTION_START,
  CODEGRAPH_SECTION_END,
} from './claude-md-template';

/**
 * Get the path to the Claude config directory
 */
function getClaudeConfigDir(location: InstallLocation): string {
  if (location === 'global') {
    return path.join(os.homedir(), '.claude');
  }
  return path.join(process.cwd(), '.claude');
}

/**
 * Get the path to the claude.json file
 * - Global: ~/.claude.json (root level)
 * - Local: ./.claude.json (project root)
 */
function getClaudeJsonPath(location: InstallLocation): string {
  if (location === 'global') {
    return path.join(os.homedir(), '.claude.json');
  }
  return path.join(process.cwd(), '.claude.json');
}

/**
 * Get the path to the settings.json file
 * - Global: ~/.claude/settings.json
 * - Local: ./.claude/settings.json
 */
function getSettingsJsonPath(location: InstallLocation): string {
  const configDir = getClaudeConfigDir(location);
  return path.join(configDir, 'settings.json');
}

/**
 * Read a JSON file, returning an empty object if it doesn't exist.
 * Distinguishes between missing files (returns {}) and corrupted
 * files (logs warning, returns {}).
 */
function readJsonFile(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Could not parse ${path.basename(filePath)}: ${msg}`);
    console.warn(`  A backup will be created before overwriting.`);
    // Create a backup of the corrupted file
    try {
      const backupPath = filePath + '.backup';
      fs.copyFileSync(filePath, backupPath);
    } catch { /* ignore backup failure */ }
    return {};
  }
}

/**
 * Write a file atomically by writing to a temp file then renaming.
 * Prevents corruption if the process crashes mid-write.
 */
function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Write a JSON file, creating parent directories if needed
 */
function writeJsonFile(filePath: string, data: Record<string, any>): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Get the MCP server configuration for the given location
 */
function getMcpServerConfig(location: InstallLocation): Record<string, any> {
  if (location === 'global') {
    // Global: use 'codegraph' command directly (assumes globally installed)
    return {
      type: 'stdio',
      command: 'codegraph',
      args: ['serve', '--mcp'],
    };
  }
  // Local: use npx to run the package
  return {
    type: 'stdio',
    command: 'npx',
    args: ['@colbymchenry/codegraph', 'serve', '--mcp'],
  };
}

/**
 * Write the MCP server configuration to claude.json
 */
export function writeMcpConfig(location: InstallLocation): void {
  const claudeJsonPath = getClaudeJsonPath(location);
  const config = readJsonFile(claudeJsonPath);

  // Ensure mcpServers object exists
  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Add or update codegraph server
  config.mcpServers.codegraph = getMcpServerConfig(location);

  writeJsonFile(claudeJsonPath, config);
}

/**
 * Get the list of permissions for CodeGraph tools
 */
function getCodeGraphPermissions(): string[] {
  return [
    'mcp__codegraph__codegraph_search',
    'mcp__codegraph__codegraph_context',
    'mcp__codegraph__codegraph_callers',
    'mcp__codegraph__codegraph_callees',
    'mcp__codegraph__codegraph_impact',
    'mcp__codegraph__codegraph_node',
    'mcp__codegraph__codegraph_status',
  ];
}

/**
 * Write permissions to settings.json
 */
export function writePermissions(location: InstallLocation): void {
  const settingsPath = getSettingsJsonPath(location);
  const settings = readJsonFile(settingsPath);

  // Ensure permissions object exists
  if (!settings.permissions) {
    settings.permissions = {};
  }

  // Ensure allow array exists
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }

  // Add CodeGraph permissions (avoiding duplicates)
  const codegraphPermissions = getCodeGraphPermissions();
  for (const permission of codegraphPermissions) {
    if (!settings.permissions.allow.includes(permission)) {
      settings.permissions.allow.push(permission);
    }
  }

  writeJsonFile(settingsPath, settings);
}

/**
 * Check if MCP config already exists for CodeGraph
 */
export function hasMcpConfig(location: InstallLocation): boolean {
  const claudeJsonPath = getClaudeJsonPath(location);
  const config = readJsonFile(claudeJsonPath);
  return !!config.mcpServers?.codegraph;
}

/**
 * Check if permissions already exist for CodeGraph
 */
export function hasPermissions(location: InstallLocation): boolean {
  const settingsPath = getSettingsJsonPath(location);
  const settings = readJsonFile(settingsPath);
  const permissions = settings.permissions?.allow;
  if (!Array.isArray(permissions)) {
    return false;
  }
  // Check if at least one CodeGraph permission exists
  return permissions.some((p: string) => p.startsWith('mcp__codegraph__'));
}

/**
 * Get the path to CLAUDE.md
 * - Global: ~/.claude/CLAUDE.md
 * - Local: ./.claude/CLAUDE.md
 */
function getClaudeMdPath(location: InstallLocation): string {
  const configDir = getClaudeConfigDir(location);
  return path.join(configDir, 'CLAUDE.md');
}

/**
 * Check if CLAUDE.md has CodeGraph section
 */
export function hasClaudeMdSection(location: InstallLocation): boolean {
  const claudeMdPath = getClaudeMdPath(location);
  try {
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      return content.includes(CODEGRAPH_SECTION_START) || content.includes('## CodeGraph');
    }
  } catch {
    // Ignore errors
  }
  return false;
}

/**
 * Write or update CLAUDE.md with CodeGraph instructions
 *
 * If the file exists and has a CodeGraph section (marked or unmarked),
 * it will be replaced. Otherwise, the template is appended.
 */
export function writeClaudeMd(location: InstallLocation): { created: boolean; updated: boolean } {
  const claudeMdPath = getClaudeMdPath(location);
  const configDir = getClaudeConfigDir(location);

  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Check if file exists
  if (!fs.existsSync(claudeMdPath)) {
    // Create new file with just the CodeGraph section
    atomicWriteFileSync(claudeMdPath, CLAUDE_MD_TEMPLATE + '\n');
    return { created: true, updated: false };
  }

  // Read existing content
  let content = fs.readFileSync(claudeMdPath, 'utf-8');

  // Check for marked section (from previous installer)
  if (content.includes(CODEGRAPH_SECTION_START)) {
    // Replace the marked section
    const startIdx = content.indexOf(CODEGRAPH_SECTION_START);
    const endIdx = content.indexOf(CODEGRAPH_SECTION_END);

    if (endIdx > startIdx) {
      // Replace existing marked section
      const before = content.substring(0, startIdx);
      const after = content.substring(endIdx + CODEGRAPH_SECTION_END.length);
      content = before + CLAUDE_MD_TEMPLATE + after;
      atomicWriteFileSync(claudeMdPath, content);
      return { created: false, updated: true };
    }
  }

  // Check for unmarked "## CodeGraph" section (from manual setup)
  const codegraphHeaderRegex = /\n## CodeGraph\n/;
  const match = content.match(codegraphHeaderRegex);

  if (match && match.index !== undefined) {
    // Find the end of the CodeGraph section (next h2 header or end of file)
    // Use negative lookahead (?!#) to match "## X" but not "### X"
    const sectionStart = match.index;
    const afterSection = content.substring(sectionStart + 1);
    const nextHeaderMatch = afterSection.match(/\n## (?!#)/);

    let sectionEnd: number;
    if (nextHeaderMatch && nextHeaderMatch.index !== undefined) {
      sectionEnd = sectionStart + 1 + nextHeaderMatch.index;
    } else {
      sectionEnd = content.length;
    }

    // Replace the section
    const before = content.substring(0, sectionStart);
    const after = content.substring(sectionEnd);
    content = before + '\n' + CLAUDE_MD_TEMPLATE + after;
    atomicWriteFileSync(claudeMdPath, content);
    return { created: false, updated: true };
  }

  // No existing section, append to end
  content = content.trimEnd() + '\n\n' + CLAUDE_MD_TEMPLATE + '\n';
  atomicWriteFileSync(claudeMdPath, content);
  return { created: false, updated: false };
}
