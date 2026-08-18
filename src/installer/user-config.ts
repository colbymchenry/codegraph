/**
 * Global user-level CodeGraph config: a small JSON file in the user-level
 * state dir (~/.codegraph), same home as telemetry.json and beta-signup.json.
 *
 * Currently one field:
 *   - `autoInit`: when true, the MCP server initializes (and indexes) any
 *     project it's asked to query that isn't indexed yet, instead of just
 *     telling the calling agent to run `codegraph init` (see
 *     src/mcp/tools.ts's getCodeGraph). Defaults to false — indexing stays
 *     the user's explicit decision unless they opt in once, here.
 *
 * A corrupted or unreadable file is treated as "no config yet" (all
 * defaults) rather than an error — a bad file must never break a tool call
 * or CLI command that merely wants to read this setting.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface UserConfigFile {
  autoInit?: boolean;
  [key: string]: unknown; // preserve fields this module doesn't know about
}

export interface UserConfigDeps {
  /** Global state dir; defaults to ~/.codegraph. Tests inject a temp dir. */
  dir?: string;
}

function configPath(deps: UserConfigDeps = {}): string {
  const home = deps.dir ?? process.env.CODEGRAPH_HOME ?? path.join(os.homedir(), '.codegraph');
  return path.join(home, 'config.json');
}

function readConfig(deps: UserConfigDeps = {}): UserConfigFile {
  try {
    return JSON.parse(fs.readFileSync(configPath(deps), 'utf8')) as UserConfigFile;
  } catch {
    return {};
  }
}

/** Whether the MCP server should auto-init an unindexed project. Default: false. */
export function getAutoInit(deps: UserConfigDeps = {}): boolean {
  return readConfig(deps).autoInit === true;
}

/** Persist the auto-init choice. Fail silent — a full disk must not break the CLI. */
export function setAutoInit(value: boolean, deps: UserConfigDeps = {}): void {
  try {
    const file = configPath(deps);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = readConfig(deps);
    const next: UserConfigFile = { ...current, autoInit: value };
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  } catch {
    /* a full disk must not break the CLI */
  }
}
