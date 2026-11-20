/**
 * `codegraph init --local-only` (#910): a `.codegraph/.gitignore` that ignores
 * itself, so a project's CodeGraph data leaves no trace in `git status`.
 *
 * The default stays as it was, because a committed `.gitignore` is how a team
 * shares the rule. So these also pin what must NOT be rewritten: a file with the
 * user's own rules, and a file a repository has already committed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getCodeGraphDir, makeGitignoreLocalOnly } from '../src/directory';
import CodeGraph from '../src/index';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

// These index a project and spawn the real CLI, up to several times a test.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const LOCAL_ONLY = '*\n';
const DEFAULT = `# CodeGraph data files — local to each machine, not for committing.
# Ignore everything in .codegraph/ except this file itself, so transient
# files (the database, daemon.pid, sockets, logs) never show up in git.
*
!.gitignore
`;
const STALE_DEFAULT = `# CodeGraph data files
*.db
*.db-wal
*.db-shm
cache/
.dirty
`;

describe('local-only .codegraph/.gitignore', () => {
  let dir: string;
  let gitignore: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-local-only-'));
    gitignore = path.join(dir, '.codegraph', '.gitignore');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedGitignore(content: string): void {
    fs.mkdirSync(path.dirname(gitignore), { recursive: true });
    fs.writeFileSync(gitignore, content);
  }

  function git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'CodeGraph Test',
        GIT_AUTHOR_EMAIL: 'codegraph-test@example.invalid',
        GIT_COMMITTER_NAME: 'CodeGraph Test',
        GIT_COMMITTER_EMAIL: 'codegraph-test@example.invalid',
      },
    });
  }

  function initRepo(): void {
    git('init', '-q');
    git('add', 'a.ts');
    git('commit', '-qm', 'baseline');
  }

  function codegraph(...args: string[]): { code: number | null; output: string } {
    const run = spawnSync(process.execPath, [BIN, ...args], {
      cwd: dir,
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', NO_COLOR: '1', DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0' },
    });
    return { code: run.status, output: run.stdout + run.stderr };
  }

  describe('makeGitignoreLocalOnly', () => {
    it('writes the wildcard alone when there is no file', () => {
      fs.mkdirSync(path.dirname(gitignore));

      expect(makeGitignoreLocalOnly(dir)).toBe('written');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(LOCAL_ONLY);
    });

    it('writes into the directory the project really uses', () => {
      const custom = process.env.CODEGRAPH_DIR;
      process.env.CODEGRAPH_DIR = '.cg-custom';
      try {
        fs.mkdirSync(getCodeGraphDir(dir));

        expect(makeGitignoreLocalOnly(dir)).toBe('written');
        expect(fs.readFileSync(path.join(dir, '.cg-custom', '.gitignore'), 'utf-8')).toBe(LOCAL_ONLY);
      } finally {
        if (custom === undefined) delete process.env.CODEGRAPH_DIR;
        else process.env.CODEGRAPH_DIR = custom;
      }
    });

    it('replaces the default CodeGraph generates, as the code generates it', () => {
      CodeGraph.initSync(dir).close();
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(DEFAULT);

      expect(makeGitignoreLocalOnly(dir)).toBe('written');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(LOCAL_ONLY);
    });

    it('replaces a default checked out with Windows line endings', () => {
      seedGitignore(DEFAULT.replace(/\n/g, '\r\n'));

      expect(makeGitignoreLocalOnly(dir)).toBe('written');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(LOCAL_ONLY);
    });

    it('replaces a default from before the wildcard', () => {
      seedGitignore(STALE_DEFAULT);

      expect(makeGitignoreLocalOnly(dir)).toBe('written');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(LOCAL_ONLY);
    });

    it.each([
      ['with a newline', '*\n'],
      ['with a Windows newline', '*\r\n'],
    ])('leaves a file that is already local-only, %s', (_label, content) => {
      seedGitignore(content);

      expect(makeGitignoreLocalOnly(dir)).toBe('unchanged');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(content);
    });

    it.each([
      ['the user wrote', 'codegraph.db\n'],
      ['we generated and the user added to', `${DEFAULT}!shared-notes.md\n`],
    ])('leaves a file %s', (_label, content) => {
      seedGitignore(content);

      expect(makeGitignoreLocalOnly(dir)).toBe('customized');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(content);
    });

    it('leaves a default the repository has committed', () => {
      seedGitignore(DEFAULT);
      initRepo();
      git('add', '.codegraph/.gitignore');
      git('commit', '-qm', 'share the rule');

      expect(makeGitignoreLocalOnly(dir)).toBe('tracked');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(DEFAULT);
      expect(git('status', '--porcelain')).toBe('');
    });

    it('replaces a default that is only untracked', () => {
      seedGitignore(DEFAULT);
      initRepo();

      expect(makeGitignoreLocalOnly(dir)).toBe('written');
    });

    it('works outside a git repository', () => {
      seedGitignore(DEFAULT);

      expect(makeGitignoreLocalOnly(dir)).toBe('written');
    });
  });

  describe('codegraph init', () => {
    it('leaves nothing in git status with --local-only', () => {
      initRepo();

      const { code, output } = codegraph('init', '-y', '--local-only');

      expect(code).toBe(0);
      expect(output).toContain('.codegraph/.gitignore now ignores itself');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(LOCAL_ONLY);
      expect(git('status', '--porcelain')).toBe('');
    });

    it('still builds the index', () => {
      codegraph('init', '-y', '--local-only');

      expect(fs.existsSync(path.join(dir, '.codegraph', 'codegraph.db'))).toBe(true);
      expect(codegraph('status').output).toContain('typescript');
    });

    it('keeps its default without the flag', () => {
      initRepo();

      const { code, output } = codegraph('init', '-y');

      expect(code).toBe(0);
      expect(output).not.toContain('ignores itself');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(DEFAULT);
      expect(git('status', '--porcelain')).toContain('.codegraph/');
    });

    it('converts an initialized project, without indexing it again', () => {
      initRepo();
      codegraph('init', '-y');
      const db = path.join(dir, '.codegraph', 'codegraph.db');
      const indexed = fs.statSync(db).mtimeMs;

      const { code, output } = codegraph('init', '-y', '--local-only');

      expect(code).toBe(0);
      expect(output).toContain('Already initialized');
      expect(output).toContain('.codegraph/.gitignore now ignores itself');
      expect(fs.statSync(db).mtimeMs).toBe(indexed);
      expect(git('status', '--porcelain')).toBe('');
    });

    it('says so when there is nothing to convert', () => {
      codegraph('init', '-y', '--local-only');

      expect(codegraph('init', '-y', '--local-only').output).toContain('.codegraph/.gitignore already ignores itself');
    });

    it('survives everything that opens the index afterwards', () => {
      codegraph('init', '-y', '--local-only');

      expect(codegraph('sync').code).toBe(0);
      expect(codegraph('status').code).toBe(0);
      expect(codegraph('index', '--quiet').code).toBe(0);
      expect(codegraph('init', '-y').code).toBe(0);
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe(LOCAL_ONLY);
    });

    it('says why it left a file with the user\'s own rules', () => {
      seedGitignore('codegraph.db\n');

      const { code, output } = codegraph('init', '-y', '--local-only');

      expect(code).toBe(0);
      expect(output).toContain('Left .codegraph/.gitignore as it is because it has your own rules');
      expect(fs.readFileSync(gitignore, 'utf-8')).toBe('codegraph.db\n');
    });

    it('says why it left a committed file, and shows no change in git', () => {
      seedGitignore(DEFAULT);
      initRepo();
      git('add', '.codegraph/.gitignore');
      git('commit', '-qm', 'share the rule');

      const { code, output } = codegraph('init', '-y', '--local-only');

      expect(code).toBe(0);
      expect(output).toContain('Left .codegraph/.gitignore as it is because it is committed');
      expect(git('status', '--porcelain')).toBe('');
    });

    it('refuses an unsafe root before touching anything', () => {
      const home = spawnSync(process.execPath, [BIN, 'init', '-y', '--local-only'], {
        cwd: os.homedir(),
        encoding: 'utf-8',
        env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', NO_COLOR: '1' },
      });

      expect(home.status).toBe(1);
      expect(fs.existsSync(path.join(os.homedir(), '.codegraph', '.gitignore'))).toBe(false);
    });

    it('offers the flag in --help', () => {
      expect(codegraph('init', '--help').output).toContain('--local-only');
    });
  });
});
