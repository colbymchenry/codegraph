/**
 * The diff reader behind `codegraph blast` (`src/graph/git-diff.ts`).
 *
 * The parser cases take the literal text `git diff --name-status -z` and
 * `git diff --unified=0` print, with no git. The `changedFiles` cases run real
 * git in temp repos (no index) to pin what the user's git config, the caller's
 * ref and the file names can do to the diff.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  applyHunks,
  changedFiles,
  parseNameStatus,
  refExists,
  type ChangedFile,
} from '../src/graph/git-diff';

/** A changed-file record with no ranges yet, as parseNameStatus leaves it. */
function bare(path: string): ChangedFile {
  return { path, status: 'modified', ranges: [], hunks: [] };
}

describe('parseNameStatus', () => {
  it('reads a rename as three NUL fields and a deletion as two', () => {
    const out = 'R096\0src/old.ts\0src/new.ts\0D\0src/gone.ts\0M\0src/kept.ts\0A\0src/fresh.ts\0';
    const files = parseNameStatus(out);
    expect(files).toEqual([
      { path: 'src/new.ts', status: 'renamed', oldPath: 'src/old.ts', ranges: [], hunks: [] },
      { path: 'src/gone.ts', status: 'deleted', ranges: [], hunks: [] },
      { path: 'src/kept.ts', status: 'modified', ranges: [], hunks: [] },
      { path: 'src/fresh.ts', status: 'added', ranges: [], hunks: [] },
    ]);
  });

  it('returns no files for empty output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe('applyHunks', () => {
  it('records a pure deletion (+N,0) as the single line before the gap', () => {
    const files = [bare('x.ts')];
    const patch = [
      'diff --git a/x.ts b/x.ts',
      'index 1111111..2222222 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -5,2 +4,0 @@',
      '-gone one',
      '-gone two',
      '',
    ].join('\n');
    applyHunks(files, patch);
    expect(files[0].ranges).toEqual([{ start: 4, end: 4 }]);
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].hunks[0]).toMatchObject({ start: 4, end: 4, dropped: 0 });
    expect(files[0].hunks[0].lines).toEqual([
      { n: null, sign: '-', text: 'gone one' },
      { n: null, sign: '-', text: 'gone two' },
    ]);
  });

  it('reads a hunk header with no count as one line', () => {
    const files = [bare('x.ts')];
    applyHunks(files, ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -7 +7 @@', '-old', '+new', ''].join('\n'));
    expect(files[0].ranges).toEqual([{ start: 7, end: 7 }]);
    expect(files[0].hunks[0].lines).toEqual([
      { n: null, sign: '-', text: 'old' },
      { n: 7, sign: '+', text: 'new' },
    ]);
  });

  it("does not absorb the second file's --- a/ header into the first file's hunk", () => {
    const files = [bare('x.ts'), bare('y.ts')];
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-old x',
      '+new x',
      'diff --git a/y.ts b/y.ts',
      '--- a/y.ts',
      '+++ b/y.ts',
      '@@ -3,0 +4,2 @@',
      '+added a',
      '+added b',
      '',
    ].join('\n');
    applyHunks(files, patch);
    const [x, y] = files;
    expect(x.ranges).toEqual([{ start: 1, end: 1 }]);
    expect(x.hunks[0].lines).toEqual([
      { n: null, sign: '-', text: 'old x' },
      { n: 1, sign: '+', text: 'new x' },
    ]);
    expect(y.ranges).toEqual([{ start: 4, end: 5 }]);
    expect(y.hunks[0].lines).toEqual([
      { n: 4, sign: '+', text: 'added a' },
      { n: 5, sign: '+', text: 'added b' },
    ]);
  });

  it('ignores hunks for a path that is not in the changed set and a +++ /dev/null file', () => {
    const files = [bare('x.ts')];
    const patch = [
      'diff --git a/other.ts b/other.ts',
      '--- a/other.ts',
      '+++ b/other.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/dead.ts b/dead.ts',
      '--- a/dead.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-c',
      '-d',
      '',
    ].join('\n');
    applyHunks(files, patch);
    expect(files[0].ranges).toEqual([]);
    expect(files[0].hunks).toEqual([]);
  });

  it('caps the text kept per hunk at 24 lines and counts the rest as dropped', () => {
    const files = [bare('x.ts')];
    const plus = Array.from({ length: 30 }, (_, i) => `+line ${i}`);
    applyHunks(files, ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -0,0 +1,30 @@', ...plus, ''].join('\n'));
    const hunk = files[0].hunks[0];
    expect(files[0].ranges).toEqual([{ start: 1, end: 30 }]);
    expect(hunk.lines).toHaveLength(24);
    expect(hunk.dropped).toBe(6);
    expect(hunk.lines[23]).toEqual({ n: 24, sign: '+', text: 'line 23' });
  });

  it('caps the text kept per file at 200 lines while still recording every range', () => {
    const files = [bare('x.ts')];
    const patch = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts'];
    // Nine hunks of 24 added lines: 216 lines, so the ninth hunk crosses the
    // 200-line file cap after 8 kept lines (8 * 24 = 192).
    for (let h = 0; h < 9; h++) {
      const start = 1 + h * 100;
      patch.push(`@@ -${start},0 +${start},24 @@`);
      for (let i = 0; i < 24; i++) patch.push(`+h${h} l${i}`);
    }
    patch.push('');
    applyHunks(files, patch.join('\n'));
    const { ranges, hunks } = files[0];
    expect(ranges).toHaveLength(9);
    expect(ranges[8]).toEqual({ start: 801, end: 824 });
    for (let h = 0; h < 8; h++) {
      expect(hunks[h].lines).toHaveLength(24);
      expect(hunks[h].dropped).toBe(0);
    }
    expect(hunks[8].lines).toHaveLength(8);
    expect(hunks[8].dropped).toBe(16);
    const kept = hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(kept).toBe(200);
  });

  it('reads a hunk body by its header counts, so an added line that looks like a +++ header stays content', () => {
    // x.ts gains a line whose text is `++ b/y.ts`, printed as `+++ b/y.ts`.
    // Taken as a header, it would credit x's second hunk to y.
    const files = [bare('x.ts'), bare('y.ts')];
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,0 +2,2 @@',
      '+const a = 1;',
      '+++ b/y.ts',
      '@@ -10 +11 @@',
      '-old x',
      '+new x',
      'diff --git a/y.ts b/y.ts',
      '--- a/y.ts',
      '+++ b/y.ts',
      '@@ -3 +3 @@',
      '-old y',
      '+new y',
      '',
    ].join('\n');
    applyHunks(files, patch);
    const [x, y] = files;
    expect(x.ranges).toEqual([{ start: 2, end: 3 }, { start: 11, end: 11 }]);
    expect(x.hunks[0].lines).toEqual([
      { n: 2, sign: '+', text: 'const a = 1;' },
      { n: 3, sign: '+', text: '++ b/y.ts' },
    ]);
    expect(y.ranges).toEqual([{ start: 3, end: 3 }]);
    expect(y.hunks).toHaveLength(1);
  });

  it('reads a removed line whose text looks like a --- header as content of its hunk', () => {
    const files = [bare('x.ts')];
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -4,2 +4 @@',
      '--- a/x.ts',
      '-gone',
      '+kept',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    applyHunks(files, patch);
    expect(files[0].ranges).toEqual([{ start: 4, end: 4 }]);
    expect(files[0].hunks[0].lines).toEqual([
      { n: null, sign: '-', text: '-- a/x.ts' },
      { n: null, sign: '-', text: 'gone' },
      { n: 4, sign: '+', text: 'kept' },
    ]);
  });
});

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=blast-test', '-c', 'user.email=blast-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

const FIVE_LINES = 'export function f(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';

describe('changedFiles on a real git repo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A one-commit repo holding src/x.ts, with line 3 then edited in the working tree. */
  function repoWithLine3Edited(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-diff-'));
    dirs.push(root);
    git(root, 'init', '-q');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/x.ts'), FIVE_LINES);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C1');
    fs.writeFileSync(path.join(root, 'src/x.ts'), FIVE_LINES.replace('const b = 2;', 'const b = 3;'));
    return root;
  }

  // Each setting changes the `+++` header git prints (`w/`, none, `new/`).
  for (const [key, value] of [
    ['diff.mnemonicPrefix', 'true'],
    ['diff.noprefix', 'true'],
    ['diff.dstPrefix', 'new/'],
  ] as const) {
    it(`reads line ranges with ${key}=${value} set in the repo`, () => {
      const root = repoWithLine3Edited();
      git(root, 'config', key, value);
      const diff = changedFiles(root);
      expect(diff?.basis).toBe('working tree vs HEAD');
      expect(diff?.files.map((f) => [f.path, f.ranges])).toEqual([['src/x.ts', [{ start: 3, end: 3 }]]]);
    });
  }

  it('refuses a base that git would parse as an option, and writes nothing', () => {
    const root = repoWithLine3Edited();
    const out = path.join(root, 'p');
    expect(changedFiles(root, `--output=${out}`)).toBeNull();
    expect(refExists(root, `--output=${out}`)).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });

  // git C-quotes each of these names in the `+++` header even with
  // core.quotePath=false: `\"` and `\\`, `\t` and `\n`, octal `\001` and `\177`,
  // the space adds a trailing tab after the quote, and the `é` stays raw UTF-8
  // inside the quotes. `--name-status -z` prints all of them unquoted.
  // Windows refuses `"`, `\` and control characters in file names.
  it.runIf(process.platform !== 'win32')('reads line ranges for files whose names git quotes in the patch', () => {
    const names = ['a"b.ts', 'a\\b.ts', 'a\tb.ts', 'a\nb.ts', 'a\x01b.ts', 'a\x7fb.ts', 'é "b.ts'];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-quoted-'));
    dirs.push(root);
    git(root, 'init', '-q');
    for (const n of names) fs.writeFileSync(path.join(root, n), FIVE_LINES);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'C1');
    for (const n of names) fs.writeFileSync(path.join(root, n), FIVE_LINES.replace('const b = 2;', 'const b = 3;'));
    const diff = changedFiles(root);
    expect(diff?.basis).toBe('working tree vs HEAD');
    expect(Object.fromEntries((diff?.files ?? []).map((f) => [f.path, f.ranges]))).toEqual(
      Object.fromEntries(names.map((n) => [n, [{ start: 3, end: 3 }]])),
    );
  });
});
