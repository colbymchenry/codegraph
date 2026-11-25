/**
 * OpenAI Codex CLI target.
 *
 *   - MCP server entry to `config.toml` as the dotted-key table
 *     `[mcp_servers.codegraph]`. TOML — not JSON — handled by the
 *     narrow serializer in `./toml.ts`.
 *   - Instructions to `AGENTS.md`.
 *
 * Both locations are supported (#1531):
 *   - global: `$CODEX_HOME/config.toml` + `$CODEX_HOME/AGENTS.md`,
 *     falling back to `~/.codex` when the env var is unset (#1627)
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
  removeFileUnlessLinked,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';
import { buildTomlTable, removeTomlTable, tomlDefinesTable, tomlLineBreak, upsertTomlTable } from './toml';

const TOML_HEADER = 'mcp_servers.codegraph';

function configDir(loc: Location): string {
  if (loc !== 'global') return path.join(process.cwd(), '.codex');
  // Codex resolves its user layer from `CODEX_HOME` and only falls back to
  // `~/.codex` (#1627). Installing to the fallback while Codex reads the
  // override is a silent no-op: the files are written, and Codex never looks
  // at them. Same resolution the copilot-cli target already does for
  // `COPILOT_HOME`. Only the user layer moves — the project layer below is
  // anchored to the project, not the profile.
  const override = process.env.CODEX_HOME;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.codex');
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
        // However the table is written — an indented or quoted header,
        // dotted keys, an inline table (#2562).
        alreadyConfigured = tomlDefinesTable(content, TOML_HEADER);
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
    const notes: string[] = [];

    const mcp = writeMcpEntry(loc);
    files.push(mcp.file);
    if (mcp.note) notes.push(mcp.note);

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    if (loc === 'local') notes.push(trustNote());
    return notes.length > 0 ? { files, notes } : { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const notes: string[] = [];

    const tomlPath = tomlConfigPath(loc);
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const result = removeTomlTable(content, TOML_HEADER);
      if (result.action === 'removed') {
        if (result.content.trim() === '') {
          removeFileUnlessLinked(tomlPath, '');
        } else {
          atomicWriteFileSync(tomlPath, result.content.trimEnd() + tomlLineBreak(content));
        }
        files.push({ path: tomlPath, action: 'removed' });
      } else {
        files.push({ path: tomlPath, action: 'not-found' });
        if (result.action === 'conflict') {
          const { conflict } = result;
          notes.push(`${tomlPath} sets ${TOML_HEADER} inside ${conflict.key} (${conflict.form}, line ${conflict.line}), which CodeGraph can't edit safely. Remove it from there yourself.`);
        }
      }
    } else {
      files.push({ path: tomlPath, action: 'not-found' });
    }

    files.push(removeInstructionsEntry(loc));

    return notes.length > 0 ? { files, notes } : { files };
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

function writeMcpEntry(loc: Location): { file: WriteResult['files'][number]; note?: string } {
  const file = tomlConfigPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const block = buildCodegraphBlock();
  // Single read — `existing === ''` derives both "is the file empty
  // or absent" and "what was its content," avoiding a TOCTOU window
  // between two `fs.existsSync` calls.
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const created = existing.length === 0;
  const result = upsertTomlTable(existing, TOML_HEADER, block);

  if (result.action === 'conflict') {
    // Never append a second definition: a table defined twice makes the
    // whole file invalid TOML, and Codex then loads none of it (#2562).
    const { conflict } = result;
    if (conflict.kind === 'defined') {
      // The user's own entry, in a form CodeGraph doesn't rewrite: it
      // already configures Codex, so it is left exactly as written.
      return {
        file: { path: file, action: 'unchanged' },
        note: `Left the ${TOML_HEADER} entry in ${file} as you wrote it (${conflict.form}, line ${conflict.line}): CodeGraph only rewrites a [${TOML_HEADER}] table.`,
      };
    }
    throw new Error(
      `${file} sets ${conflict.key} as ${conflict.form} (line ${conflict.line}), so a [${TOML_HEADER}] table can't be added without breaking the file. ` +
      `Nothing was changed: add CodeGraph's server to ${conflict.key} yourself, or rewrite it as [${conflict.key}.<name>] tables, then run this again.`,
    );
  }
  if (result.action === 'unchanged') {
    return { file: { path: file, action: 'unchanged' } };
  }
  atomicWriteFileSync(file, result.content);
  return { file: { path: file, action: created ? 'created' : 'updated' } };
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
