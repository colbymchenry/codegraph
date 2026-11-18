/**
 * `codegraph.json` `include` brings gitignored first-party source into the
 * index (#1063), and `codegraph sync` keeps it current, but `codegraph status`
 * missed every change to it (#3086): in a git project its pending-change check
 * takes candidates from `git status`, which never reports an ignored file. An
 * edit, an added file and a deleted one under an included, ignored folder all
 * read as "up to date". Status now also checks the included files, by the same
 * stat test sync uses, so it reports exactly what a sync would pick up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('status sees changes to gitignored source that `include` brings in (#3086)', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-status-included-'));
    write('.gitignore', 'local/\n');
    write('codegraph.json', JSON.stringify({ include: ['local/'], exclude: ['local/generated/'] }));
    write('src/Main.java', 'package app;\npublic class Main {\n  void run() {}\n}\n');
    write('local/A.java', 'package local;\npublic class A {\n  public int one() { return 1; }\n}\n');
    write('local/generated/G.java', 'package local.generated;\npublic class G {}\n');
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'base');
    cg = await CodeGraph.init(dir, { index: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexes the included file and calls a fresh index up to date', () => {
    expect(cg!.getFile('local/A.java')).not.toBeNull();
    expect(cg!.getFile('local/generated/G.java')).toBeNull();
    expect(cg!.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
  });

  it('reports an edit, an added file and a deleted file under the included folder', () => {
    write('local/A.java', 'package local;\npublic class A {\n  public int one() { return 1; }\n  public int two() { return 2; }\n}\n');
    expect(cg!.getChangedFiles()).toEqual({ added: [], modified: ['local/A.java'], removed: [] });

    write('local/B.java', 'package local;\npublic class B {}\n');
    // Excluded by `codegraph.json`, so neither indexed nor pending.
    write('local/generated/H.java', 'package local.generated;\npublic class H {}\n');
    expect(cg!.getChangedFiles().added).toEqual(['local/B.java']);

    fs.rmSync(path.join(dir, 'local/A.java'));
    const changes = cg!.getChangedFiles();
    expect(changes.removed).toEqual(['local/A.java']);
    expect(changes.added).toEqual(['local/B.java']);
    expect(changes.modified).toEqual([]);
  });

  it('agrees with sync: once a sync has run, nothing is pending', async () => {
    write('local/A.java', 'package local;\npublic class A {\n  public int three() { return 3; }\n}\n');
    write('local/B.java', 'package local;\npublic class B {}\n');
    expect(cg!.getChangedFiles().modified).toEqual(['local/A.java']);
    await cg!.sync();
    expect(cg!.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
    expect(cg!.getNodesByName('three')).toHaveLength(1);
    expect(cg!.getFile('local/B.java')).not.toBeNull();
  });

  // The include walk follows each folder's real path, with the OS's realpath
  // first. Some volumes refuse that call where the JS realpath works (a RAM
  // disk, some subst and network drives), and a walk that gave the folder up
  // there dropped every included file from status and from the index alike.
  it('still walks an included folder whose volume refuses the OS realpath', async () => {
    const native = fs.realpathSync.native;
    const refused = (p: fs.PathLike): boolean => /[\\/]local(?:[\\/]|$)/.test(String(p));
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, options?: unknown) => {
      if (refused(p)) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, realpath '${String(p)}'`), { code: 'EISDIR' });
      return native(p, options as BufferEncoding);
    }) as typeof fs.realpathSync.native);

    // Status: an edit under the folder is pending.
    write('local/A.java', 'package local;\npublic class A {\n  public int four() { return 4; }\n}\n');
    expect(cg!.getChangedFiles().modified).toEqual(['local/A.java']);

    // Indexing: a fresh index of the same tree has the included file.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-status-included-copy-'));
    try {
      fs.cpSync(dir, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}.codegraph`) });
      const fresh = await CodeGraph.init(copy, { index: true });
      try {
        expect(fresh.getFile('local/A.java')).not.toBeNull();
        expect(fresh.getNodesByName('four')).toHaveLength(1);
      } finally {
        fresh.destroy();
      }
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
    expect(vi.mocked(fs.realpathSync.native).mock.calls.some(([p]) => refused(p))).toBe(true);
  });

  it('leaves a rewrite of the same bytes alone', () => {
    const file = path.join(dir, 'local/A.java');
    fs.writeFileSync(file, fs.readFileSync(file));
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    expect(cg!.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
  });
});
