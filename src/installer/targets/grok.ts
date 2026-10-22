/**
 * Grok Build (xAI) target. Writes:
 *
 *   - MCP server entry to `~/.grok/config.toml` (global) or
 *     `./.grok/config.toml` (local) as the dotted-key table
 *     `[mcp_servers.codegraph]`. TOML — not JSON — handled by
 *     the narrow serializer in `./toml.ts` (same as Codex).
 *
 * Grok reads project rules from `AGENTS.md` files natively, so no
 * separate instructions file is needed — the MCP `initialize`
 * response is the single source of truth for agent-facing guidance
 * (issue #529). A prior install that wrote a `<!-- CODEGRAPH_START -->`
 * block into an AGENTS.md is self-healed on upgrade (stripped by
 * install, same as other targets).
 *
 * No permissions concept — Grok gates tool invocations through its
 * own UI prompts rather than an external allowlist. `autoAllow` is
 * silently ignored.
 *
 * Config dir resolution: `~/.grok/` (preferred) or `$GROK_HOME`
 * (env override). Project-scoped config lives at `.grok/config.toml`
 * relative to the project root.
 *
 * Docs: https://docs.x.ai/docs/mcp
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
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml';

const TOML_HEADER = 'mcp_servers.codegraph';

function globalConfigDir(): string {
  const grokHome = process.env.GROK_HOME;
  return grokHome || path.join(os.homedir(), '.grok');
}
function tomlConfigPath(loc: Location): string {
  return loc === 'global'
    ? path.join(globalConfigDir(), 'config.toml')
    : path.join(process.cwd(), '.grok', 'config.toml');
}
/**
 * Grok reads AGENTS.md natively from the project root and from
 * `~/.grok/`. We write the marker-fenced block to the global
 * AGENTS.md so subagents and non-MCP harnesses see it (#704).
 * Project-local AGENTS.md at the cwd is left to the user.
 */
function instructionsPath(): string {
  return path.join(globalConfigDir(), 'AGENTS.md');
}

class GrokTarget implements AgentTarget {
  readonly id = 'grok' as const;
  readonly displayName = 'Grok Build';
  readonly docsUrl = 'https://docs.x.ai/docs/mcp';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const tomlPath = tomlConfigPath(loc);
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch { /* ignore */ }
    }
    const configDir = loc === 'global' ? globalConfigDir() : path.join(process.cwd(), '.grok');
    const installed = fs.existsSync(configDir) || fs.existsSync(tomlPath);
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));

    // Global AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    // Only write for global — project-local AGENTS.md is the user's domain.
    if (loc === 'global') {
      files.push(upsertInstructionsEntry(instructionsPath()));
    }

    return {
      files,
      notes: ['Restart Grok for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const tomlPath = tomlConfigPath(loc);
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
      if (action === 'removed') {
        if (nextContent.trim() === '') {
          try { fs.unlinkSync(tomlPath); } catch { /* ignore */ }
          // Also remove the .grok/ dir if it's now empty (project-local only;
          // never remove the global ~/.grok/ — it has other files).
          if (loc === 'local') {
            const dir = path.dirname(tomlPath);
            try {
              if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
            } catch { /* ignore */ }
          }
        } else {
          atomicWriteFileSync(tomlPath, nextContent.trimEnd() + '\n');
        }
        files.push({ path: tomlPath, action: 'removed' });
      } else {
        files.push({ path: tomlPath, action: 'not-found' });
      }
    } else {
      files.push({ path: tomlPath, action: 'not-found' });
    }

    // Strip the marker-delimited block from global AGENTS.md if a prior
    // install wrote one. Only for global — local AGENTS.md is the user's.
    if (loc === 'global') {
      files.push(removeInstructionsEntry());
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const block = buildCodegraphBlock();
    const target = tomlConfigPath(loc);
    return `# Add to ${target}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [tomlConfigPath(loc)];
    if (loc === 'global') paths.push(instructionsPath());
    return paths;
  }
}

function buildCodegraphBlock(): string {
  const mcp = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = tomlConfigPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const block = buildCodegraphBlock();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const created = existing.length === 0;
  const { content: nextContent, action } = upsertTomlTable(existing, TOML_HEADER, block);

  if (action === 'unchanged') {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, nextContent);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * Strip the marker-delimited CodeGraph block from `~/.grok/AGENTS.md`
 * if a prior install wrote one. Used by both install (self-heal on
 * upgrade) and uninstall — see issue #529.
 */
function removeInstructionsEntry(): WriteResult['files'][number] {
  const file = instructionsPath();
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const grokTarget: AgentTarget = new GrokTarget();
