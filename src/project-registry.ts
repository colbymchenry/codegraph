/**
 * Cross-project registry — the discovery layer behind the `codegraph_projects`
 * MCP tool and `codegraph projects`.
 *
 * A CodeGraph index lives inside its project (`.codegraph/`), so nothing about
 * where the projects ARE is knowable without being told each one. `codegraph
 * init` registers a project here and `codegraph uninit` removes it, which lets
 * an agent enumerate the projects it can query through `projectPath`.
 *
 * This is a DISCOVERY index, never a source of truth: the `.codegraph/`
 * directory is. Readers tolerate an entry whose index has since gone (the
 * summary reports it as not indexed), and every write is best-effort — a
 * registry problem must never fail `init`/`uninit`. The atomic tmp+rename keeps
 * readers from seeing a half-written file; concurrent inits are last-writer-
 * wins, which is acceptable for a convenience index (a later init of the lost
 * project re-adds it).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalProjectRoot } from './directory';

/** Points the registry at a different file (tests, or a shared home). */
export const PROJECTS_REGISTRY_ENV = 'CODEGRAPH_PROJECTS_PATH';

const REGISTRY_VERSION = 1;

export interface RegisteredProject {
  /** Absolute project root, spelled as it was at registration. */
  path: string;
  /** ISO timestamp of the last registration. */
  registeredAt: string;
}

export interface ProjectsRegistry {
  /** The file that was read. */
  path: string;
  /** Deduplicated, sorted by path. Empty when the registry is missing/unreadable. */
  projects: RegisteredProject[];
  /** Set when the file exists but could not be read or parsed. */
  error: string | null;
}

/**
 * `$CODEGRAPH_PROJECTS_PATH`, else `~/.codegraph/projects.json` — the global
 * state directory the daemon registry and update check already use.
 */
export function getProjectsRegistryPath(): string {
  const override = process.env[PROJECTS_REGISTRY_ENV]?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.codegraph', 'projects.json');
}

/**
 * Every registered project, deduplicated by canonical root. Never throws: a
 * missing registry is an empty list, and a corrupt one is an empty list plus
 * an `error` the caller can surface.
 */
export function readProjectsRegistry(): ProjectsRegistry {
  const file = getProjectsRegistryPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: file, projects: [], error: null };
    }
    return { path: file, projects: [], error: `could not be read (${(err as Error).message})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { path: file, projects: [], error: 'is not valid JSON' };
  }

  // A bare array is accepted so a hand-maintained registry keeps working.
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(list)) {
    return { path: file, projects: [], error: 'does not contain a project list' };
  }

  const byIdentity = new Map<string, RegisteredProject>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { path?: unknown; registeredAt?: unknown };
    if (typeof entry.path !== 'string' || !entry.path.trim()) continue;
    let resolved: string;
    try {
      resolved = path.resolve(entry.path);
    } catch {
      continue;
    }
    const identity = canonicalProjectRoot(resolved);
    if (byIdentity.has(identity)) continue; // one project, two spellings
    byIdentity.set(identity, {
      path: resolved,
      registeredAt: typeof entry.registeredAt === 'string' ? entry.registeredAt : '',
    });
  }

  return {
    path: file,
    projects: [...byIdentity.values()].sort((a, b) => a.path.localeCompare(b.path)),
    error: null,
  };
}

/** Add (or refresh) one project. Best-effort: never fails the caller. */
export function registerProject(projectRoot: string): void {
  try {
    const root = path.resolve(projectRoot);
    const identity = canonicalProjectRoot(root);
    const { projects } = readProjectsRegistry();
    const next = projects.filter((p) => canonicalProjectRoot(p.path) !== identity);
    next.push({ path: root, registeredAt: new Date().toISOString() });
    writeProjectsRegistry(next);
  } catch {
    /* discovery is a convenience; init/uninit must not fail over it */
  }
}

/** Remove one project. Best-effort: never fails the caller. */
export function unregisterProject(projectRoot: string): void {
  try {
    const identity = canonicalProjectRoot(path.resolve(projectRoot));
    const { projects, error } = readProjectsRegistry();
    // A corrupt file holds nothing we can safely rewrite; leave it for a
    // later init to replace wholesale.
    if (error) return;
    const next = projects.filter((p) => canonicalProjectRoot(p.path) !== identity);
    if (next.length === projects.length) return;
    writeProjectsRegistry(next);
  } catch {
    /* discovery is a convenience; init/uninit must not fail over it */
  }
}

function writeProjectsRegistry(projects: RegisteredProject[]): void {
  const file = getProjectsRegistryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sorted = [...projects].sort((a, b) => a.path.localeCompare(b.path));
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: REGISTRY_VERSION, projects: sorted }, null, 2) + '\n',
      { mode: 0o600 }
    );
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* renamed already, or never written */
    }
  }
}
