import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectWorktreeIndexMismatch, nestedRepositoryBelow } from '../src/sync/worktree';
const roots: string[] = [];
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
describe('worktree directory identity', () => {
  it.runIf(process.platform === 'win32')('recognizes linked worktrees through an 8.3 path', context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-directory-identity-'));
    roots.push(root);
    git(root, ['init', '-q']);
    git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'init']);
    const worktree = path.join(root, 'linked-worktree');
    git(root, ['worktree', 'add', '-qb', 'feature', worktree]);
    const shortRoot = execFileSync('cmd.exe', ['/d', '/c', 'for %I in (.) do @echo %~fsI'], {
      cwd: root, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
    }).trim();
    if (shortRoot.toLowerCase() === root.toLowerCase()) context.skip();
    expect(fs.statSync(shortRoot).ino).toBe(fs.statSync(root).ino);
    const shortWorktree = path.join(shortRoot, 'linked-worktree');
    expect(nestedRepositoryBelow(shortWorktree, root)).toBeNull();
    expect(detectWorktreeIndexMismatch(shortWorktree, root)).not.toBeNull();
    expect(detectWorktreeIndexMismatch(shortRoot, root)).toBeNull();
  });
});
