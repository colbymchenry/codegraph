/**
 * Regression: git older than 2.36 rejects `ls-files -s --recurse-submodules` (#1549).
 *
 * Kept in its own file rather than appended to extraction.test.ts: that suite
 * loads every tree-sitter grammar in `beforeAll`, and running a git-scan case
 * after it pushed the worker past its memory ceiling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { scanDirectory } from '../src/extraction';

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
// A PATH shim reproduces that on any git version, which is what makes this
// testable in CI at all.
describe('Old git without `ls-files -s --recurse-submodules` support (#1549)', () => {
  let tempDir: string;
  let originalPath: string | undefined;

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

  /** A `git` that dies exactly like < 2.36 when it sees -s with --recurse-submodules. */
  const installOldGitShim = () => {
    const shimDir = path.join(tempDir, '.shim');
    fs.mkdirSync(shimDir, { recursive: true });
    const realGit = execFileSync('which', ['git']).toString().trim();
    const shim = path.join(shimDir, 'git');
    fs.writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'for a in "$@"; do',
        '  [ "$a" = "--recurse-submodules" ] && rs=1',
        '  [ "$a" = "-s" ] && st=1',
        'done',
        'if [ -n "$rs" ] && [ -n "$st" ]; then',
        '  echo "fatal: ls-files --recurse-submodules unsupported mode" >&2',
        '  exit 128',
        'fi',
        `exec ${JSON.stringify(realGit)} "$@"`,
      ].join('\n'),
    );
    fs.chmodSync(shim, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
  };

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    originalPath = undefined;
  });

  it('still honours includeIgnored when `ls-files --recurse-submodules` is unsupported', () => {
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
    expect(withRealGit).toContain(path.join('dir_b', 'b.ts'));

    installOldGitShim();

    // The opted-in file must survive the unsupported-mode failure, not vanish.
    const withOldGit = scanDirectory(root);
    expect(withOldGit).toContain('a.ts');
    expect(withOldGit).toContain(path.join('dir_b', 'b.ts'));
  });
});
