/**
 * `codegraph diff`: semantic merge conflicts between two refs, end to end
 * against the built binary and a real git repository. The scenario is the one
 * git cannot see: one branch renames a function while the other adds a caller
 * in a different file, so the textual merge is clean and the program is broken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

let dir: string;
let cache: string;

function git(...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commitAll(message: string): void {
  git('add', '-A');
  git('commit', '-m', message);
}

function run(...args: string[]) {
  const res = spawnSync(process.execPath, [BIN, 'diff', ...args, '--path', dir], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_WASM_RELAUNCHED: '1',
      CODEGRAPH_REF_CACHE: cache,
    },
    timeout: 240_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-diff-')));
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-diff-cache-'));
  git('init', '-q');
  write('lib.ts', 'export function compute(x: number) { return x * 2; }\n');
  write('app.ts', "import { compute } from './lib';\nexport function main() { return compute(1); }\n");
  commitAll('base');
  git('branch', '-M', 'main');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

describe('codegraph diff', () => {
  it('finds a caller added on one branch to a function the other renamed', () => {
    git('checkout', '-q', '-b', 'rename');
    write('lib.ts', 'export function calculate(x: number) { return x * 2; }\n');
    write('app.ts', "import { calculate } from './lib';\nexport function main() { return calculate(1); }\n");
    commitAll('rename compute');

    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'caller');
    write('extra.ts', "import { compute } from './lib';\nexport function extra() { return compute(2); }\n");
    commitAll('add caller');

    const res = run('rename', 'caller', '--json');
    expect(res.stderr).not.toContain('failed');
    const report = JSON.parse(res.stdout);
    expect(report.textualConflict).toBe(false);
    const broken = report.conflicts.filter((c: { kind: string }) => c.kind === 'broken-caller');
    expect(broken).toHaveLength(1);
    expect(broken[0].symbol).toContain('compute');
    expect(broken[0].dependents.join(' ')).toContain('extra');
    expect(res.status).toBe(1);
  });

  it('exits 0 for independent changes', () => {
    git('checkout', '-q', '-b', 'one');
    write('one.ts', 'export function one() { return 1; }\n');
    commitAll('one');
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'two');
    write('two.ts', 'export function two() { return 2; }\n');
    commitAll('two');

    const res = run('one', 'two');
    expect(res.stdout).toContain('No semantic conflicts');
    expect(res.status).toBe(0);
  });

  it('does not call a line shift a change', () => {
    git('checkout', '-q', '-b', 'shift');
    write('lib.ts', '// a new leading comment\n\nexport function compute(x: number) { return x * 2; }\n');
    commitAll('shift lines');
    git('checkout', '-q', 'main');

    const res = run('shift', 'main', '--json');
    const report = JSON.parse(res.stdout);
    expect(report.a.removed).toEqual([]);
    expect(report.a.added).toEqual([]);
    expect(report.a.changed).toEqual([]);
    expect(report.a.moved).toBeGreaterThan(0);
  });

  describe('--sweep', () => {
    function makeBranches(): void {
      git('checkout', '-q', '-b', 'feature/rename');
      write('lib.ts', 'export function calculate(x: number) { return x * 2; }\n');
      write('app.ts', "import { calculate } from './lib';\nexport function main() { return calculate(1); }\n");
      commitAll('rename compute');
      git('checkout', '-q', 'main');
      git('checkout', '-q', '-b', 'feature/independent');
      write('other.ts', 'export function other() { return 3; }\n');
      commitAll('independent');
      git('checkout', '-q', 'main');
      git('checkout', '-q', '-b', 'merged');
      git('checkout', '-q', 'main');
      git('checkout', '-q', '-b', 'chore/caller');
      write('extra.ts', "import { compute } from './lib';\nexport function extra() { return compute(2); }\n");
      commitAll('add caller');
      git('checkout', '-q', 'main');
      // The target moves on: main itself now holds the rename.
      write('lib.ts', 'export function calculate(x: number) { return x * 2; }\n');
      write('app.ts', "import { calculate } from './lib';\nexport function main() { return calculate(1); }\n");
      commitAll('main renames compute');
    }

    it('ranks branches against the target and exits 1 on a conflict', () => {
      makeBranches();
      const res = run('--sweep', 'main', '--json');
      const report = JSON.parse(res.stdout);
      const status = Object.fromEntries(report.branches.map((b: { branch: string; status: string }) => [b.branch, b.status]));
      expect(status['chore/caller']).toBe('semantic-conflict');
      expect(status['feature/independent']).toBe('clean');
      expect(status['merged']).toBe('up-to-date');
      // The target is never compared with itself, and the worst case comes first.
      expect(status['main']).toBeUndefined();
      expect(report.branches[0].branch).toBe('chore/caller');
      expect(res.status).toBe(1);
    });

    it('limits the sweep to branches matching --branches', () => {
      makeBranches();
      const report = JSON.parse(run('--sweep', 'main', '--branches', 'feature/*', '--json').stdout);
      expect(report.branches.map((b: { branch: string }) => b.branch).sort()).toEqual([
        'feature/independent',
        'feature/rename',
      ]);
    });

    it('rejects a bad --limit and an unknown target', () => {
      expect(run('--sweep', 'main', '--limit', '0').status).toBe(1);
      const res = run('--sweep', 'no-such-branch');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('no-such-branch');
    });
  });

  describe('--cherry-pick', () => {
    let helperCommit: string;
    let callerCommit: string;

    beforeEach(() => {
      git('checkout', '-q', '-b', 'feat');
      write('lib.ts', 'export function compute(x: number) { return x * 2; }\nexport function helper() { return 7; }\n');
      commitAll('add helper');
      helperCommit = git('rev-parse', 'HEAD').trim();
      write(
        'app.ts',
        "import { compute, helper } from './lib';\nexport function main() { return compute(1); }\nexport function extra() { return helper(); }\n",
      );
      commitAll('use helper');
      callerCommit = git('rev-parse', 'HEAD').trim();
      git('checkout', '-q', 'main');
    });

    it('flags a commit that uses something the target lacks and names the commit that adds it', () => {
      const res = run('--cherry-pick', callerCommit, '--onto', 'main', '--json');
      const report = JSON.parse(res.stdout);
      expect(report.verdict).toBe('missing-dependencies');
      expect(report.missing).toHaveLength(1);
      expect(report.missing[0].kind).toBe('absent');
      expect(report.missing[0].symbol).toContain('helper');
      expect(report.prerequisites[0].commits.map((c: { sha: string }) => c.sha)).toEqual([helperCommit]);
      expect(res.status).toBe(1);
    });

    it('is safe once the prerequisite is on the target', () => {
      git('cherry-pick', helperCommit);
      const res = run('--cherry-pick', callerCommit, '--onto', 'main', '--json');
      const report = JSON.parse(res.stdout);
      expect(report.verdict).toBe('safe');
      expect(res.status).toBe(0);
    });

    it('is safe for a self-contained commit', () => {
      const res = run('--cherry-pick', helperCommit, '--onto', 'main', '--json');
      expect(JSON.parse(res.stdout).verdict).toBe('safe');
      expect(res.status).toBe(0);
    });

    it('needs --onto and refuses a root commit', () => {
      expect(run('--cherry-pick', callerCommit).status).toBe(1);
      const root = git('rev-list', '--max-parents=0', 'main').trim();
      const res = run('--cherry-pick', root, '--onto', 'main');
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('root commit');
    });
  });

  describe('--rebase', () => {
    let middle: string;

    function makeTopic(): void {
      git('checkout', '-q', '-b', 'topic');
      write('one.ts', 'export function one() { return 1; }\n');
      commitAll('add one');
      write('extra.ts', "import { compute } from './lib';\nexport function extra() { return compute(2); }\n");
      commitAll('call compute');
      middle = git('rev-parse', 'HEAD').trim();
      write('three.ts', 'export function three() { return 3; }\n');
      commitAll('add three');
      git('checkout', '-q', 'main');
    }

    function renameOnMain(): void {
      write('lib.ts', 'export function calculate(x: number) { return x * 2; }\n');
      write('app.ts', "import { calculate } from './lib';\nexport function main() { return calculate(1); }\n");
      commitAll('rename compute');
    }

    it('names the first commit that breaks against the new base', () => {
      makeTopic();
      renameOnMain();
      const res = run('--rebase', 'topic', '--onto', 'main', '--json');
      const report = JSON.parse(res.stdout);
      expect(report.status).toBe('breaks-at-commit');
      expect(report.firstBreaking).toBe(middle);
      expect(report.commits.map((c: { verdict: string }) => c.verdict)).toEqual(['safe', 'missing-dependencies', 'safe']);
      expect(report.endConflicts.length).toBeGreaterThan(0);
      expect(res.status).toBe(1);
    });

    it('is safe when the new base changed something unrelated', () => {
      makeTopic();
      write('unrelated.ts', 'export function unrelated() { return 0; }\n');
      commitAll('main moves on');
      const res = run('--rebase', 'topic', '--onto', 'main', '--json');
      const report = JSON.parse(res.stdout);
      expect(report.status).toBe('safe');
      expect(report.firstBreaking).toBeNull();
      expect(res.status).toBe(0);
    });

    it('reports a branch that is already on the target, or already merged', () => {
      makeTopic();
      expect(JSON.parse(run('--rebase', 'topic', '--onto', 'main', '--json').stdout).status).toBe('fast-forward');
      git('merge', '-q', '--ff-only', 'topic');
      expect(JSON.parse(run('--rebase', 'topic', '--onto', 'main', '--json').stdout).status).toBe('nothing-to-rebase');
    });

    it('needs --onto', () => {
      expect(run('--rebase', 'main').status).toBe(1);
    });
  });

  it('reports an unknown ref plainly', () => {
    const res = run('main', 'no-such-branch');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('no-such-branch');
  });
});
