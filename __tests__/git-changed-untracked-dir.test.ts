/**
 * Regression test for #1213: `codegraph sync` silently skips untracked files
 * that live inside an untracked directory.
 *
 * `git status --porcelain` collapses an entirely-untracked directory into a
 * single `?? frontend/` entry. getGitChangedFiles must still surface the source
 * files inside it (via `-uall`) rather than dropping the whole directory.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getGitChangedFiles } from '../src/extraction/index';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('getGitChangedFiles — untracked directories (#1213)', () => {
  const dirs: string[] = [];

  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1213-'));
    dirs.push(dir);
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'root.js'), 'function foo() {}\n');
    git(dir, ['add', 'root.js']);
    git(dir, ['commit', '-m', 'init']);
    return dir;
  }

  afterEach(() => {
    while (dirs.length) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('detects source files inside a fully-untracked directory', () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, 'frontend'));
    fs.writeFileSync(path.join(dir, 'frontend', 'app.js'), 'function bar() {}\n');

    const changes = getGitChangedFiles(dir);

    expect(changes).not.toBeNull();
    expect(changes!.added).toContain('frontend/app.js');
  });

  it('still recurses into an untracked embedded git repo (no -uall regression)', () => {
    // `-uall` must not break the embedded-repo path: git collapses a nested
    // repo to `?? embedded/` regardless of `-uall`, so its files are only
    // reachable through collectGitStatus's recursion.
    const dir = makeRepo();
    const embedded = path.join(dir, 'embedded');
    fs.mkdirSync(embedded);
    git(embedded, ['init']);
    fs.writeFileSync(path.join(embedded, 'inner.js'), 'function baz() {}\n');

    const changes = getGitChangedFiles(dir);

    expect(changes).not.toBeNull();
    expect(changes!.added).toContain('embedded/inner.js');
  });
});
