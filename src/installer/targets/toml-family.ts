/**
 * toml-family target factory — Codex-shaped agents.
 *
 * The mechanics of the Codex CLI target — an `[mcp_servers.codegraph]`
 * table written by the narrow serializer in `./toml.ts` into
 * `<configDir>/config.toml`, AGENTS.md instructions next to it — apply
 * verbatim to other TOML-config agents (Grok Build, #1324). This
 * factory turns a spec into a complete `AgentTarget`; the built-in
 * codex target is one instantiation, custom targets (`./custom.ts`,
 * family `"toml"`) are others.
 *
 * Spec knobs beyond Codex's shape, both motivated by #1324:
 *   - `homeEnvVar` — an env var that overrides the global config dir
 *     (Grok's `GROK_HOME`). When set and non-empty it wins.
 *   - `localConfigDir` — enables `--location=local` with a
 *     `./<dir>/config.toml` project config. Codex has no project-local
 *     config concept (as of 2026-05), so the built-in leaves it unset
 *     and the orchestrator skips codex for local installs.
 *
 * Instructions (AGENTS.md) are global-only, matching Codex — local
 * TOML agents read the project config for servers but the global
 * AGENTS.md for instructions.
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

export interface TomlFamilySpec {
  /** Registry id, e.g. 'codex', 'grok'. */
  id: string;
  displayName: string;
  docsUrl?: string;
  /**
   * Global config dir; absolute or `~/`-prefixed (expanded against
   * `os.homedir()`), e.g. '~/.codex'. Validated by `custom.ts` for
   * user specs.
   */
  configDir: string;
  /** Env var that overrides `configDir` when set and non-empty. */
  homeEnvVar?: string;
  /**
   * Project-local config dir name (e.g. '.grok') holding a
   * `config.toml`. Absent = the agent is global-only.
   */
  localConfigDir?: string;
  /** Config file basename. Default 'config.toml'. */
  configFileName?: string;
}

const TOML_HEADER = 'mcp_servers.codegraph';

export function expandHomeDir(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

class TomlFamilyTarget implements AgentTarget {
  readonly id: string;
  readonly displayName: string;
  readonly docsUrl?: string;

  constructor(private readonly spec: TomlFamilySpec) {
    this.id = spec.id;
    this.displayName = spec.displayName;
    this.docsUrl = spec.docsUrl;
  }

  private globalConfigDir(): string {
    if (this.spec.homeEnvVar) {
      const override = process.env[this.spec.homeEnvVar];
      if (override && override.trim().length > 0) return override;
    }
    return expandHomeDir(this.spec.configDir);
  }

  private configDir(loc: Location): string {
    return loc === 'global'
      ? this.globalConfigDir()
      : path.join(process.cwd(), this.spec.localConfigDir!);
  }

  private tomlConfigPath(loc: Location): string {
    return path.join(this.configDir(loc), this.spec.configFileName ?? 'config.toml');
  }

  private instructionsPath(): string {
    return path.join(this.globalConfigDir(), 'AGENTS.md');
  }

  supportsLocation(loc: Location): boolean {
    return loc === 'global' || !!this.spec.localConfigDir;
  }

  detect(loc: Location): DetectionResult {
    if (!this.supportsLocation(loc)) {
      return { installed: false, alreadyConfigured: false };
    }
    const tomlPath = this.tomlConfigPath(loc);
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch { /* ignore */ }
    }
    const installed = loc === 'global'
      ? fs.existsSync(this.globalConfigDir())
      : fs.existsSync(tomlPath);
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (!this.supportsLocation(loc)) {
      return {
        files: [],
        notes: [`${this.displayName} has no project-local config — re-run with --location=global to install.`],
      };
    }
    const files: WriteResult['files'] = [];

    files.push(this.writeMcpEntry(loc));

    // AGENTS.md gets the short marker-fenced CodeGraph block (#704):
    // subagents and non-MCP harnesses read AGENTS.md but never the MCP
    // initialize instructions. Upsert self-heals a stale pre-#529 block.
    // Global-only, matching Codex — a local install still reads the
    // global AGENTS.md.
    if (loc === 'global') files.push(upsertInstructionsEntry(this.instructionsPath()));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    if (!this.supportsLocation(loc)) return { files: [] };
    const files: WriteResult['files'] = [];

    const tomlPath = this.tomlConfigPath(loc);
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
      if (action === 'removed') {
        if (nextContent.trim() === '') {
          try { fs.unlinkSync(tomlPath); } catch { /* ignore */ }
          // A local dir we emptied entirely was ours — remove it too so
          // uninstall reverses install; rmdir refuses non-empty dirs.
          if (loc === 'local') {
            try { fs.rmdirSync(path.dirname(tomlPath)); } catch { /* ignore */ }
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

    if (loc === 'global') files.push(this.removeInstructionsEntry());

    return { files };
  }

  printConfig(loc: Location): string {
    if (!this.supportsLocation(loc)) {
      return `# ${this.displayName} has no project-local config — use --location=global.\n`;
    }
    const block = buildCodegraphBlock();
    return `# Add to ${this.tomlConfigPath(loc)}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    if (!this.supportsLocation(loc)) return [];
    const paths = [this.tomlConfigPath(loc)];
    if (loc === 'global') paths.push(this.instructionsPath());
    return paths;
  }

  private writeMcpEntry(loc: Location): WriteResult['files'][number] {
    const file = this.tomlConfigPath(loc);
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
   * Strip the marker-delimited CodeGraph block from the global
   * AGENTS.md if a prior install wrote one. Used by both install
   * (self-heal on upgrade) and uninstall — see issue #529.
   */
  private removeInstructionsEntry(): WriteResult['files'][number] {
    const file = this.instructionsPath();
    const action = removeMarkedSection(file, CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END);
    return { path: file, action };
  }
}

function buildCodegraphBlock(): string {
  const mcp = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

export function createTomlFamilyTarget(spec: TomlFamilySpec): AgentTarget {
  return new TomlFamilyTarget(spec);
}
