/**
 * Cursor target.
 *
 *   - MCP server entry to `~/.cursor/mcp.json` (global) or
 *     `./.cursor/mcp.json` (local). Same `{mcpServers: {...}}` shape
 *     as Claude.
 *   - Instructions to `./.cursor/rules/codegraph.mdc` (project-local
 *     ONLY). Cursor's rules system is a project-scoped surface;
 *     global cursor rules aren't a stable convention as of 2026-05.
 *     For `--location=global`, only mcp.json is written.
 *
 * ## Why we hardcode `--path` for Cursor
 *
 * Cursor launches MCP-server subprocesses with a working directory
 * that ISN'T the workspace root AND doesn't pass `rootUri` /
 * `workspaceFolders` in the MCP initialize call. The codegraph MCP
 * server's `process.cwd()` fallback therefore misses the workspace's
 * `.codegraph/` and reports "not initialized" on every tool call.
 *
 * So we inject `--path` into the args ourselves:
 *
 *   - `local`  install: absolute path (we know it at install time).
 *   - `global` install: `${workspaceFolder}` — Cursor expands this to
 *     the open workspace's root, giving us per-workspace behavior
 *     from a single global config.
 *
 * Codex and Claude do not need this — they launch MCP servers with
 * `cwd = workspace` and pass `rootUri`, respectively.
 *
 * No permissions concept — Cursor doesn't have an auto-allow list
 * the installer can populate. `autoAllow` is silently ignored.
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
  atomicWriteFileSync,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.cursor', 'mcp.json')
    : path.join(process.cwd(), '.cursor', 'mcp.json');
}
/**
 * Cursor "rules" file. Only meaningful for the project-local
 * location — Cursor reads `.cursor/rules/*.mdc` from the workspace
 * root. There is no global equivalent.
 */
function rulesPath(): string {
  return path.join(process.cwd(), '.cursor', 'rules', 'codegraph.mdc');
}

/**
 * Cursor `.mdc` rules use YAML-ish frontmatter. `alwaysApply: true`
 * makes the rule load on every conversation regardless of file
 * patterns — appropriate for a tool-usage guide that's relevant
 * whenever the user is asking the agent to navigate code.
 */
const MDC_FRONTMATTER = [
  '---',
  'description: CodeGraph MCP usage guide — when to use which tool',
  'alwaysApply: true',
  '---',
  '',
].join('\n');

class CursorTarget implements AgentTarget {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor';
  readonly docsUrl = 'https://docs.cursor.com/context/model-context-protocol';

  supportsLocation(_loc: Location): boolean {
    // Both supported, but `local` writes more files (mcp.json + rules);
    // `global` writes only mcp.json. The orchestrator surfaces the
    // difference via describePaths.
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    // "Installed" heuristic: does ~/.cursor exist (global) or has the
    // user opted into a project-local cursor config dir?
    const installed = loc === 'global'
      ? fs.existsSync(path.join(os.homedir(), '.cursor'))
      : fs.existsSync(path.join(process.cwd(), '.cursor'));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));

    // We no longer write `.cursor/rules/codegraph.mdc` — the codegraph
    // usage guidance ships in the MCP server's `initialize` response,
    // the single source of truth (issue #529). Strip a rules file a
    // previous install created so an upgrade self-heals.
    if (loc === 'local') {
      const rulesCleanup = removeRulesEntry();
      if (rulesCleanup.action === 'removed') files.push(rulesCleanup);
    }

    return {
      files,
      notes: ['Restart Cursor for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const mcpPath = mcpJsonPath(loc);
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

    if (loc === 'local') {
      files.push(removeRulesEntry());
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { codegraph: buildCursorMcpConfig(loc) } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'local'
      ? [mcpJsonPath(loc), rulesPath()]
      : [mcpJsonPath(loc)];
  }
}

/**
 * Build the codegraph MCP-server config for Cursor at the given
 * location. Inherits the shared shape ({type, command, args}) and
 * appends `--path` so the spawned MCP server resolves the workspace
 * correctly regardless of Cursor's launch cwd. See file header for
 * the full rationale.
 */
function buildCursorMcpConfig(loc: Location): { type: string; command: string; args: string[] } {
  const base = getMcpServerConfig();
  const pathArg = loc === 'local' ? process.cwd() : '${workspaceFolder}';
  return { ...base, args: [...base.args, '--path', pathArg] };
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = buildCursorMcpConfig(loc);

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Remove the Cursor rules file on uninstall (and as a self-heal on
 * install — see issue #529).
 *
 * Unlike the shared CLAUDE.md / AGENTS.md files (where codegraph owns
 * only a marker-delimited section), `.cursor/rules/codegraph.mdc` is a
 * file we create OUTRIGHT — the frontmatter is ours too. So a plain
 * `removeMarkedSection` is wrong here: it would strip our instruction
 * block but leave the orphaned `description: CodeGraph ...` frontmatter
 * behind, so the file lingers and still "mentions" codegraph.
 *
 * Instead: strip our block, and if nothing but our own frontmatter
 * remains, delete the whole file. Only when the user has added their
 * own content outside our markers do we keep the file (minus our block).
 */
function removeRulesEntry(): WriteResult['files'][number] {
  const file = rulesPath();
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return { path: file, action: 'not-found' };
  }

  const ourFrontmatter = MDC_FRONTMATTER.trim();
  const startIdx = content.indexOf(CODEGRAPH_SECTION_START);
  const endIdx = content.indexOf(CODEGRAPH_SECTION_END);

  // Our marked block is present — strip it, then decide what's left.
  if (startIdx !== -1 && endIdx > startIdx) {
    const before = content.substring(0, startIdx).trimEnd();
    const after = content.substring(endIdx + CODEGRAPH_SECTION_END.length).trimStart();
    const remainder = (before + (before && after ? '\n\n' : '') + after).trim();
    if (remainder === '' || remainder === ourFrontmatter) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    } else {
      atomicWriteFileSync(file, remainder + '\n');
    }
    return { path: file, action: 'removed' };
  }

  // No block, but the file is still our pristine frontmatter-only file
  // — it's ours, so remove it.
  if (content.trim() === ourFrontmatter) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    return { path: file, action: 'removed' };
  }

  // Foreign content we don't recognize — leave it alone.
  return { path: file, action: 'not-found' };
}

export const cursorTarget: AgentTarget = new CursorTarget();
