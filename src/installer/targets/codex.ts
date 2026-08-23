/**
 * OpenAI Codex CLI target.
 *
 *   - MCP server entry to `config.toml` as the dotted-key table
 *     `[mcp_servers.codegraph]`. TOML — not JSON — handled by the
 *     narrow serializer in `./toml.ts`.
 *   - Instructions to `AGENTS.md`.
 *
 * Both locations are supported (#1531):
 *   - global: `~/.codex/config.toml` + `~/.codex/AGENTS.md`
 *   - local:  `<cwd>/.codex/config.toml` + `<cwd>/AGENTS.md`
 *
 * Codex has a first-class project config layer: `.codex/config.toml`
 * is layer 4 of the loader's stack, above the user config (layer 6),
 * merged recursively top-over-bottom
 * (`codex-rs/config/src/loader/README.md` in openai/codex). It landed
 * in openai/codex#8354 (2025-12-22), so the "Codex has no
 * project-local config" note this file used to carry was never
 * accurate. The project layer strips a denylist of settings that
 * repo contents shouldn't get to choose (base URLs, model providers,
 * `notify`, profiles, otel — `loader/mod.rs`), and `mcp_servers` is
 * NOT on it, so a project-scoped `[mcp_servers.codegraph]` is honored.
 *
 * Caveat surfaced as an install note: project layers are "loaded but
 * disabled when untrusted," so a local install only takes effect in a
 * project the user has marked trusted.
 *
 * No permissions concept.
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

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.codex')
    : path.join(process.cwd(), '.codex');
}
function tomlConfigPath(loc: Location): string {
  return path.join(configDir(loc), 'config.toml');
}
function instructionsPath(loc: Location): string {
  // Global AGENTS.md lives under ~/.codex/; project-local AGENTS.md
  // lives at the project root (NOT under .codex/) — that's the file
  // Codex reads for repo instructions, and it matches the local
  // layout the opencode and gemini targets already use.
  return loc === 'global'
    ? path.join(configDir('global'), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

/**
 * Project layers are "loaded but disabled when untrusted" (openai/codex
 * `loader/mod.rs`), so a local install can be written correctly and
 * still do nothing. Say so rather than reporting silent success.
 */
function trustNote(): string {
  return `Codex applies ${tomlConfigPath('local')} only in a project marked trusted — otherwise the layer is loaded but disabled. Trust this project in Codex to activate it.`;
}

class CodexTarget implements AgentTarget {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly docsUrl = 'https://github.com/openai/codex';

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
    // Global: ~/.codex/ existing means Codex has run here. Local: the
    // project only counts as "Codex-enabled" once it actually has a
    // .codex/ dir or config file of its own.
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(tomlPath);
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return loc === 'local' ? { files, notes: [trustNote()] } : { files };
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

    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const block = buildCodegraphBlock();
    return `# Add to ${tomlConfigPath(loc)}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    return [tomlConfigPath(loc), instructionsPath(loc)];
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
  // Single read — `existing === ''` derives both "is the file empty
  // or absent" and "what was its content," avoiding a TOCTOU window
  // between two `fs.existsSync` calls.
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
 * Strip the marker-delimited CodeGraph block from this location's
 * AGENTS.md if a prior install wrote one. Used by both install
 * (self-heal on upgrade) and uninstall — see issue #529.
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
  return { path: file, action };
}

export const codexTarget: AgentTarget = new CodexTarget();
