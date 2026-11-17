/**
 * Change detection reads git without taking `.git/index.lock` (#3295).
 *
 * With git's optional locks on, `git status` writes the stat info it refreshed
 * back to the index, and holds `index.lock` from that refresh through the whole
 * untracked scan. A `git add` in a pre-commit hook or a `git checkout` that
 * started inside that window failed at once with "index.lock: File exists",
 * and the watcher syncs exactly when such a command churns files.
 *
 * The observable difference is the index file: a status run that took the lock
 * rewrites `.git/index` with the refreshed stat info, one that didn't leaves it
 * byte for byte. Each case first checks that a plain `git status` in the same
 * state does rewrite it, so the assertion can't pass vacuously.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { getGitChangedFiles } from '../src/extraction/index';

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
}

/** Give a tracked file new stat info with the same content, so status has an entry to refresh. */
function staleStatInfo(file: string, offsetSec: number): void {
  const when = new Date(Date.now() - offsetSec * 1000);
  fs.utimesSync(file, when, when);
}

describe('change detection never takes the git index lock (#3295)', () => {
  let root: string;
  let savedOptionalLocks: string | undefined;

  beforeEach(() => {
    // The env a user's shell might set would hide the bug: test git's default.
    savedOptionalLocks = process.env.GIT_OPTIONAL_LOCKS;
    delete process.env.GIT_OPTIONAL_LOCKS;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-optional-locks-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(): number { return b(); }\nexport function b(): number { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { a } from './a';\nexport const c = (): number => a();\n");
    git(root, ['init', '-q']);
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    // Untracked files too: the scan git holds the lock through.
    fs.mkdirSync(path.join(root, 'notes'));
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, 'notes', `n${i}.txt`), `${i}\n`);
  });

  afterEach(() => {
    if (savedOptionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = savedOptionalLocks;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const indexBytes = (): Buffer => fs.readFileSync(path.join(root, '.git', 'index'));

  /** A plain `git status` in this state rewrites the index: the setup can see a write. */
  function expectPlainStatusWritesIndex(file: string, offsetSec: number): void {
    staleStatInfo(file, offsetSec);
    const before = indexBytes();
    git(root, ['status', '--porcelain']);
    expect(indexBytes().equals(before)).toBe(false);
  }

  it('getGitChangedFiles leaves .git/index untouched', () => {
    const file = path.join(root, 'src', 'a.ts');
    expectPlainStatusWritesIndex(file, 3600);

    staleStatInfo(file, 7200);
    const before = indexBytes();
    const changes = getGitChangedFiles(root);
    expect(changes).not.toBeNull();
    // Same answer as ever: nothing tracked changed, only untracked non-source files.
    expect(changes!.modified).toEqual([]);
    expect(indexBytes().equals(before)).toBe(true);
    expect(fs.existsSync(path.join(root, '.git', 'index.lock'))).toBe(false);
  });

  it('a sync and a status check leave .git/index untouched', async () => {
    const cg = await CodeGraph.init(root);
    try {
      await cg.indexAll();
      const file = path.join(root, 'src', 'c.ts');
      expectPlainStatusWritesIndex(file, 3600);

      // `codegraph sync` and the watcher's syncs.
      staleStatInfo(file, 7200);
      let before = indexBytes();
      await cg.sync();
      expect(indexBytes().equals(before)).toBe(true);

      // `codegraph status` and the MCP freshness checks.
      staleStatInfo(file, 10800);
      before = indexBytes();
      cg.getChangedFiles();
      expect(indexBytes().equals(before)).toBe(true);
    } finally {
      cg.close();
    }
  });
});
