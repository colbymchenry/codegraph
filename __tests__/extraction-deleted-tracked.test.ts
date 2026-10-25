import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';

describe('Git-tracked files deleted from the working tree (#2904)', () => {
  let root: string;

  const runGit = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'pipe' });

  const writeSource = (repo: string, relativePath: string) => {
    const file = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'def example():\n    return 1\n');
  };

  const commit = (repo: string) => {
    runGit(
      repo,
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=Test',
      '-c', 'commit.gpgSign=false',
      'commit', '-q', '-m', 'fixture',
    );
  };

  const expectFiles = async (expected: string[]) => {
    // Exercise both public scan paths before asserting, so a regression shows
    // whether the synchronous and asynchronous results disagree.
    const actual = {
      sync: scanDirectory(root).sort(),
      async: (await scanDirectoryAsync(root)).sort(),
    };
    const sorted = [...expected].sort();
    expect(actual).toEqual({ sync: sorted, async: sorted });
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deleted-tracked-'));
    runGit(root, 'init', '-q');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['committed', 'staged'] as const)(
    'skips a deleted %s file while retaining an existing tracked file',
    async (state) => {
      writeSource(root, 'keep.py');
      writeSource(root, 'gone.py');
      runGit(root, 'add', '--', 'keep.py', 'gone.py');
      if (state === 'committed') commit(root);
      fs.unlinkSync(path.join(root, 'gone.py'));

      await expectFiles(['keep.py']);
    },
  );

  it('skips a deleted tracked file in an embedded repository', async () => {
    writeSource(root, 'app.py');
    runGit(root, 'add', '--', 'app.py');
    commit(root);

    const embedded = path.join(root, 'embedded');
    fs.mkdirSync(embedded);
    runGit(embedded, 'init', '-q');
    writeSource(embedded, 'keep.py');
    writeSource(embedded, 'gone.py');
    runGit(embedded, 'add', '--', 'keep.py', 'gone.py');
    commit(embedded);
    fs.unlinkSync(path.join(embedded, 'gone.py'));

    await expectFiles(['app.py', 'embedded/keep.py']);
  });

  it('skips tracked descendants when their directory is replaced by a file', async () => {
    writeSource(root, 'keep.py');
    writeSource(root, 'previous/gone.py');
    runGit(root, 'add', '--', 'keep.py', 'previous/gone.py');
    commit(root);
    fs.rmSync(path.join(root, 'previous'), { recursive: true });
    fs.writeFileSync(path.join(root, 'previous'), 'directory replaced by a file');

    await expectFiles(['keep.py']);
  });

  it('retains visible untracked files and ignores staged or untracked deletions', async () => {
    writeSource(root, 'keep.py');
    writeSource(root, 'removed.py');
    runGit(root, 'add', '--', 'keep.py', 'removed.py');
    commit(root);
    runGit(root, 'rm', '-q', '--', 'removed.py');
    writeSource(root, 'untracked.py');
    writeSource(root, 'gone-untracked.py');
    fs.unlinkSync(path.join(root, 'gone-untracked.py'));

    await expectFiles(['keep.py', 'untracked.py']);
  });

  it.runIf(process.platform !== 'win32')('retains a dangling tracked symlink', async () => {
    fs.symlinkSync('missing-target.py', path.join(root, 'broken.py'));
    runGit(root, 'add', '--', 'broken.py');

    await expectFiles(['broken.py']);
  });
});
