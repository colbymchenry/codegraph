/**
 * `codegraph projects` end-to-end (issue #769): `init` registers a project,
 * `projects` lists it (human + --json), `uninit` removes it.
 *
 * Runs the built binary so the commander wiring and the registry writes are
 * exercised for real; `CODEGRAPH_PROJECTS_PATH` points every child at a
 * throwaway registry, so the developer's own projects are never read or
 * written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCodegraph(args: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        NO_COLOR: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      status: e.status ?? -1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
}

/** The command's JSON body, ignoring any advisory line a startup hook prints. */
function parseJsonOutput(stdout: string): {
  registryPath: string;
  error: string | null;
  projects: Array<{
    projectPath: string;
    status: string;
    lastIndexedAt: string | null;
    stats: { fileCount: number; nodeCount: number; edgeCount: number } | null;
    pendingChanges: { added: number; modified: number; removed: number } | null;
    registeredAt: string | null;
  }>;
} {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`No JSON object in output:\n${stdout}`);
  return JSON.parse(stdout.slice(start, end + 1));
}

describe('codegraph projects (e2e, issue #769)', () => {
  let tempDir: string;
  let registryPath: string;
  let projectA: string;
  let projectB: string;

  const env = () => ({ CODEGRAPH_PROJECTS_PATH: registryPath });
  const identity = (p: string) => fs.realpathSync.native(p);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-projects-'));
    registryPath = path.join(tempDir, 'home', '.codegraph', 'projects.json');
    projectA = path.join(tempDir, 'alpha');
    projectB = path.join(tempDir, 'beta');
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(project);
      fs.writeFileSync(
        path.join(project, 'index.ts'),
        'export function handler(input: string): string { return input.trim(); }\n'
      );
    }
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('init registers projects and projects lists them until uninit removes one', () => {
    const initA = runCodegraph(['init', '--yes'], projectA, env());
    expect(initA.status, initA.stdout + initA.stderr).toBe(0);
    const initB = runCodegraph(['init', '--yes'], projectB, env());
    expect(initB.status, initB.stdout + initB.stderr).toBe(0);

    const listed = runCodegraph(['projects', '--json'], tempDir, env());
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    const json = parseJsonOutput(listed.stdout);
    expect(json.registryPath).toBe(path.resolve(registryPath));
    expect(json.error).toBeNull();
    expect(json.projects).toHaveLength(2);
    expect(json.projects.map((p) => identity(p.projectPath)).sort()).toEqual(
      [identity(projectA), identity(projectB)].sort()
    );
    for (const project of json.projects) {
      expect(project.status).toBe('up-to-date');
      expect(project.stats).not.toBeNull();
      expect(project.stats!.fileCount).toBeGreaterThan(0);
      expect(project.lastIndexedAt).not.toBeNull();
      expect(Number.isNaN(Date.parse(project.lastIndexedAt!))).toBe(false);
      expect(project.registeredAt).not.toBeNull();
    }

    // Human output names each project and its state.
    const human = runCodegraph(['projects'], tempDir, env());
    expect(human.status, human.stdout + human.stderr).toBe(0);
    expect(human.stdout).toContain('CodeGraph Projects');
    expect(human.stdout).toContain(identity(projectA));
    expect(human.stdout).toContain(identity(projectB));
    expect(human.stdout).toContain('up to date');
    expect(human.stdout).toContain(`Registry: ${path.resolve(registryPath)}`);

    // A working-tree edit shows up as out of date.
    fs.writeFileSync(
      path.join(projectA, 'index.ts'),
      'export function handler(input: string): string { return input.toLowerCase(); }\n'
    );
    const stale = parseJsonOutput(runCodegraph(['projects', '--json'], tempDir, env()).stdout);
    const alpha = stale.projects.find((p) => identity(p.projectPath) === identity(projectA))!;
    expect(alpha.status).toBe('out-of-date');
    expect(alpha.pendingChanges).toEqual({ added: 0, modified: 1, removed: 0 });
    expect(stale.projects.find((p) => identity(p.projectPath) === identity(projectB))!.status).toBe(
      'up-to-date'
    );

    // Uninit removes both the index and the registry entry.
    const removed = runCodegraph(['uninit', '--force'], projectA, env());
    expect(removed.status, removed.stdout + removed.stderr).toBe(0);
    const after = parseJsonOutput(runCodegraph(['projects', '--json'], tempDir, env()).stdout);
    expect(after.projects).toHaveLength(1);
    expect(identity(after.projects[0]!.projectPath)).toBe(identity(projectB));
  }, 240_000);

  it('points at an empty registry before any project is initialized', () => {
    const empty = runCodegraph(['projects'], tempDir, env());
    expect(empty.status, empty.stdout + empty.stderr).toBe(0);
    expect(empty.stdout).toContain('No CodeGraph projects are registered yet.');
    expect(empty.stdout).toContain('codegraph init');

    const emptyJson = runCodegraph(['projects', '--json'], tempDir, env());
    const json = parseJsonOutput(emptyJson.stdout);
    expect(json.projects).toEqual([]);
    expect(json.error).toBeNull();
  }, 120_000);
});
