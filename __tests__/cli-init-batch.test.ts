/**
 * `codegraph init --all <dirs...>` (batch indexing across many repos).
 *
 * Exercised end-to-end against the built binary, matching the convention in
 * cli-query-command.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function initAll(dirs: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, 'init', '--all', ...dirs], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString('utf-8') ?? '', status: e.status ?? 1 };
  }
}

function initSingle(dir: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, 'init', dir], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString('utf-8') ?? '', status: e.status ?? 1 };
  }
}

function makeRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export function main(){ return 1; }\n');
  return dir;
}

describe('codegraph init --all', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-init-batch-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('indexes every directory listed and reports a summary line per repo', () => {
    const repoA = makeRepo(root, 'repo-a');
    const repoB = makeRepo(root, 'repo-b');

    const { stdout, status } = initAll([repoA, repoB]);

    expect(status).toBe(0);
    expect(stdout).toContain(repoA);
    expect(stdout).toContain(repoB);
    expect(fs.existsSync(path.join(repoA, '.codegraph'))).toBe(true);
    expect(fs.existsSync(path.join(repoB, '.codegraph'))).toBe(true);
  });

  it('continues past an already-initialized directory instead of stopping the batch', () => {
    const repoA = makeRepo(root, 'repo-a');
    const repoB = makeRepo(root, 'repo-b');
    execFileSync(process.execPath, [BIN, 'init', repoA], {
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: 'ignore',
    });

    const { stdout, status } = initAll([repoA, repoB]);

    expect(status).toBe(0);
    expect(stdout).toContain('already');
    expect(fs.existsSync(path.join(repoB, '.codegraph'))).toBe(true);
  });

  it('reports a refusal for an unsafe directory without aborting the rest of the batch', () => {
    const repoB = makeRepo(root, 'repo-b');

    const { stdout, status } = initAll([os.homedir(), repoB]);

    expect(status).toBe(1); // batch exit code reflects the refusal
    expect(stdout).toContain('refused');
    expect(fs.existsSync(path.join(repoB, '.codegraph'))).toBe(true); // but repo-b still got indexed
  });
});

describe('codegraph init (single-path regression)', () => {
  it('refuses to index home directory and exits with code 1', () => {
    const { stdout, status } = initSingle(os.homedir());

    expect(status).toBe(1);
    expect(stdout).toContain('Refusing');
  });
});

describe('codegraph init --git-hooks (single path)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-init-githooks-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('installs the hooks without prompting when --git-hooks is passed to a single-path init', () => {
    const repo = makeRepo(root, 'repo-a');
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });

    // The flag's whole point is "yes, install them" — but single mode passed
    // `yes: mode === 'batch'`, i.e. always false, so offerWatchFallback still
    // ran clack.select() and the user could answer "manual" and get no hooks
    // at all. In a non-interactive context (setup script, CI) that prompt has
    // nobody to answer it.
    //
    // stdin is /dev/null here and nothing stubs `select`, so a surviving
    // prompt cannot resolve to 'hook' by accident: the only way the hooks get
    // installed is the non-interactive `yes` path.
    const stdout = execFileSync(
      process.execPath,
      [BIN, 'init', repo, '--git-hooks'],
      {
        encoding: 'utf-8',
        env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 120_000,
      },
    );

    expect(stdout).not.toContain('How should CodeGraph keep its index fresh?');
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(true);
  });
});
