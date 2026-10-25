/**
 * `codegraph.json` → `maxThreads` — the project-shared worker-thread ceiling
 * (#2527).
 *
 * A team that indexes on shared CI runners or laptops wants one knob that says
 * "CodeGraph may use at most N threads here", committed next to the code
 * instead of exported per shell. Locked below: the value is read and validated
 * like every other project-config key (warn-and-skip on anything that is not a
 * positive integer — an unparseable config must never break indexing), and it
 * loses to `--threads` on the CLI while beating `CODEGRAPH_MAX_THREADS`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMaxThreads, PROJECT_CONFIG_FILENAME } from '../src/project-config';
import { resolveProjectThreadLimit, resetThreadBudget } from '../src/thread-budget';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-maxthreads-'));
});

afterEach(() => {
  resetThreadBudget();
  delete process.env.CODEGRAPH_CLI_THREADS;
  delete process.env.CODEGRAPH_MAX_THREADS;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeConfig(body: unknown): void {
  fs.writeFileSync(path.join(root, PROJECT_CONFIG_FILENAME), JSON.stringify(body, null, 2));
}

describe('codegraph.json maxThreads', () => {
  it('is undefined when the project has no config at all', () => {
    expect(loadMaxThreads(root)).toBeUndefined();
  });

  it('is undefined when the key is absent', () => {
    writeConfig({ extensions: { '.dota_lua': 'lua' } });
    expect(loadMaxThreads(root)).toBeUndefined();
  });

  it('reads a positive integer', () => {
    writeConfig({ maxThreads: 4 });
    expect(loadMaxThreads(root)).toBe(4);
    expect(resolveProjectThreadLimit({ projectRoot: root, availableParallelism: 18 }))
      .toEqual({ total: 4, source: 'config' });
  });

  it('warns and skips values that are not positive integers', () => {
    // A fresh root per value: the config loader is mtime-cached, and rewriting
    // one file in a tight loop can land inside the same millisecond.
    for (const bad of [0, -1, 2.5, '8', null, true]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-maxthreads-bad-'));
      fs.writeFileSync(path.join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ maxThreads: bad }));
      expect(loadMaxThreads(dir), `maxThreads=${JSON.stringify(bad)}`).toBeUndefined();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fall back to an empty config when maxThreads is the only key', () => {
    writeConfig({ maxThreads: 4 });
    expect(loadMaxThreads(root)).toBe(4);
  });

  it('survives a malformed config file instead of throwing', () => {
    fs.writeFileSync(path.join(root, PROJECT_CONFIG_FILENAME), '{ not json');
    expect(loadMaxThreads(root)).toBeUndefined();
  });

  it('honours --threads over the config, and the config over the env', () => {
    writeConfig({ maxThreads: 4 });
    process.env.CODEGRAPH_MAX_THREADS = '2';
    expect(resolveProjectThreadLimit({ projectRoot: root, availableParallelism: 18 }).source).toBe('config');
    process.env.CODEGRAPH_CLI_THREADS = '6';
    expect(resolveProjectThreadLimit({ projectRoot: root, availableParallelism: 18 }))
      .toEqual({ total: 6, source: 'flag' });
  });

  it('falls through to CODEGRAPH_MAX_THREADS when the project has no maxThreads', () => {
    process.env.CODEGRAPH_MAX_THREADS = '2';
    expect(resolveProjectThreadLimit({ projectRoot: root, availableParallelism: 18 }))
      .toEqual({ total: 2, source: 'env' });
  });
});
