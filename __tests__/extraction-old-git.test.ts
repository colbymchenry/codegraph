/**
 * Regression: git older than 2.36 rejects `ls-files -s --recurse-submodules` (#1549).
 *
 * Kept in its own file rather than appended to extraction.test.ts: that suite
 * loads every tree-sitter grammar in `beforeAll`, and running a git-scan case
 * after it pushed the worker past its memory ceiling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { scanDirectory } from '../src/extraction';

// Fail only the unsupported invocation; repository discovery and fallback Git
// commands still execute against real repositories on every platform.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}

// git < 2.36 rejects `ls-files -s --recurse-submodules` outright: the guard in
// builtin/ls-files.c listed `show_stage` among the modes that die, and it was
// only dropped in 2.36. The die is unconditional — it does not check whether the
// repo has submodules — so on Ubuntu 22.04 (git 2.34.1), Debian 11 (2.30.2) and
// older, every call threw, `getGitVisibleFiles` swallowed it, and the whole
// git-visible path went with it: `includeIgnored`, gitlink recursion and the
// `codegraph.json` `include` allowlist all silently stopped applying (#1549).
//
// Inject the old Git error on any installed version, including Git for Windows.
describe('Old git without `ls-files -s --recurse-submodules` support (#1549)', () => {
  let tempDir: string;

  const runGit = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'pipe' });

  const makeRepo = (dir: string, base: string) => {
    fs.mkdirSync(dir, { recursive: true });
    runGit(dir, 'init', '-q');
    runGit(dir, 'config', 'user.email', 'test@test.com');
    runGit(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, `${base}.ts`), `export const ${base} = 1;`);
    runGit(dir, 'add', '-A');
    runGit(dir, 'commit', '-q', '-m', `${base} init`);
  };

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
    tempDir = createTempDir();
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('still honours includeIgnored when `ls-files --recurse-submodules` is unsupported', async () => {
    const root = path.join(tempDir, 'root');
    makeRepo(root, 'a');
    // An embedded repo that .gitignore excludes but codegraph.json opts back in.
    makeRepo(path.join(root, 'dir_b'), 'b');
    fs.writeFileSync(path.join(root, '.gitignore'), 'dir_b/\n');
    fs.writeFileSync(
      path.join(root, 'codegraph.json'),
      JSON.stringify({ includeIgnored: ['dir_b/'] }),
    );
    runGit(root, 'add', '-A');
    runGit(root, 'commit', '-q', '-m', 'ignore dir_b');

    // Baseline: the real git resolves both files.
    const withRealGit = scanDirectory(root);
    expect(withRealGit).toContain('a.ts');
    expect(withRealGit).toContain('dir_b/b.ts');

    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    let rejected = 0;
    let retried = 0;
    vi.mocked(execFileSync).mockImplementation(((file, args, options) => {
      if (file === 'git' && Array.isArray(args) && args[0] === 'ls-files' && args.includes('-s')) {
        if (args.includes('--recurse-submodules')) {
          rejected++;
          throw new Error('fatal: ls-files --recurse-submodules unsupported mode');
        }
        retried++;
      }
      return actual.execFileSync(file, args, options);
    }) as typeof execFileSync);

    // The opted-in file must survive the unsupported-mode failure, not vanish.
    const withOldGit = scanDirectory(root);
    expect(withOldGit).toContain('a.ts');
    expect(withOldGit).toContain('dir_b/b.ts');
    expect(rejected).toBeGreaterThan(0);
    expect(retried).toBe(rejected);
  });
});
