/**
 * The cross-project registry behind `codegraph_projects` / `codegraph projects`.
 *
 * It is a discovery index, not a source of truth (`.codegraph/` is), and every
 * operation is best-effort: a missing, unreadable or corrupt file must yield an
 * empty list — never an exception that could fail `init`/`uninit`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PROJECTS_REGISTRY_ENV,
  getProjectsRegistryPath,
  readProjectsRegistry,
  registerProject,
  unregisterProject,
} from '../src/project-registry';

describe('project registry', () => {
  let tempDir: string;
  let registryPath: string;
  let projectA: string;
  let projectB: string;
  const original = process.env[PROJECTS_REGISTRY_ENV];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-registry-'));
    registryPath = path.join(tempDir, 'state', 'projects.json');
    projectA = path.join(tempDir, 'alpha');
    projectB = path.join(tempDir, 'beta');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    process.env[PROJECTS_REGISTRY_ENV] = registryPath;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (original === undefined) delete process.env[PROJECTS_REGISTRY_ENV];
    else process.env[PROJECTS_REGISTRY_ENV] = original;
  });

  const real = (p: string) => fs.realpathSync.native(p);
  // Stored paths keep their registered spelling; identity comparisons go
  // through the canonical root (macOS `$TMPDIR` is a `/var` → `/private/var`
  // symlink, so raw strings can differ where the project is identical).
  const identity = (p: string) => real(path.resolve(p));

  it('defaults to ~/.codegraph/projects.json when the env override is unset', () => {
    delete process.env[PROJECTS_REGISTRY_ENV];
    expect(getProjectsRegistryPath()).toBe(path.join(os.homedir(), '.codegraph', 'projects.json'));
  });

  it('honors CODEGRAPH_PROJECTS_PATH', () => {
    expect(getProjectsRegistryPath()).toBe(path.resolve(registryPath));
  });

  it('a missing registry is an empty list, not an error', () => {
    const got = readProjectsRegistry();
    expect(got).toEqual({ path: path.resolve(registryPath), projects: [], error: null });
  });

  it('registers a project and reads it back', () => {
    registerProject(projectA);
    const got = readProjectsRegistry();
    expect(got.error).toBeNull();
    expect(got.projects).toHaveLength(1);
    expect(identity(got.projects[0]!.path)).toBe(identity(projectA));
    expect(Number.isNaN(Date.parse(got.projects[0]!.registeredAt))).toBe(false);
  });

  it('deduplicates one project registered under two spellings', () => {
    registerProject(projectA);
    registerProject(real(projectA));
    registerProject(`${projectA}${path.sep}`);
    expect(readProjectsRegistry().projects).toHaveLength(1);
  });

  it('re-registering refreshes the entry instead of duplicating it', () => {
    const now = vi.spyOn(Date.prototype, 'toISOString');
    try {
      now.mockReturnValueOnce('2026-01-01T00:00:00.000Z');
      registerProject(projectA);
      now.mockReturnValueOnce('2026-02-02T00:00:00.000Z');
      registerProject(projectA);
    } finally {
      now.mockRestore();
    }
    const got = readProjectsRegistry();
    expect(got.projects).toHaveLength(1);
    expect(got.projects[0]!.registeredAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('sorts projects by path', () => {
    registerProject(projectB);
    registerProject(projectA);
    expect(readProjectsRegistry().projects.map((p) => identity(p.path))).toEqual([
      identity(projectA),
      identity(projectB),
    ]);
  });

  it('unregisters only the named project', () => {
    registerProject(projectA);
    registerProject(projectB);
    unregisterProject(projectA);
    const got = readProjectsRegistry();
    expect(got.projects.map((p) => identity(p.path))).toEqual([identity(projectB)]);
  });

  it('unregistering an unknown project is a no-op (and creates no file)', () => {
    unregisterProject(projectA);
    expect(fs.existsSync(registryPath)).toBe(false);
    expect(readProjectsRegistry().projects).toEqual([]);
  });

  it('a corrupt registry is an empty list plus a reportable error', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, '{ not json');
    const got = readProjectsRegistry();
    expect(got.projects).toEqual([]);
    expect(got.error).toBe('is not valid JSON');
  });

  it('a well-formed file without a project list is reported', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1 }));
    const got = readProjectsRegistry();
    expect(got.projects).toEqual([]);
    expect(got.error).toBe('does not contain a project list');
  });

  it('accepts a hand-maintained bare array and skips unusable entries', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify([
        { path: projectA, registeredAt: '2026-01-01T00:00:00.000Z' },
        { path: 42 },
        { notAPath: true },
        null,
        'alpha',
      ])
    );
    const got = readProjectsRegistry();
    expect(got.error).toBeNull();
    expect(got.projects).toEqual([
      { path: path.resolve(projectA), registeredAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('registering over a corrupt file replaces it with a valid registry', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, 'garbage');
    registerProject(projectA);
    const got = readProjectsRegistry();
    expect(got.error).toBeNull();
    expect(got.projects.map((p) => identity(p.path))).toEqual([identity(projectA)]);
  });

  it('an unreadable registry path is reported, never thrown', () => {
    // A directory where the file should be makes readFileSync fail with EISDIR.
    fs.mkdirSync(registryPath, { recursive: true });
    const got = readProjectsRegistry();
    expect(got.projects).toEqual([]);
    expect(got.error).toMatch(/could not be read/);
  });

  it('writes the registry owner-only', () => {
    registerProject(projectA);
    if (process.platform !== 'win32') {
      expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600);
    }
  });
});
