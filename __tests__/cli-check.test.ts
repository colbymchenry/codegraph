/**
 * `codegraph check` — CLI subcommand that prints file-level circular import
 * cycles and exits non-zero when any are found (so it works as a git
 * pre-commit hook: `codegraph check || exit 1`).
 *
 * Indexing is done via the library (CodeGraph.initSync + indexAll), matching
 * the proven cli-affected-paths.test.ts pattern — avoids interactive prompts
 * and daemon spawning. The command under test is invoked end-to-end against
 * the built binary in dist/.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cwd: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [BIN, 'check', cwd], {
      encoding: 'utf8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Index a temp project from a map of rel-path -> file content, then close. */
async function indexProject(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  cg.close();
}

describe('codegraph check (CLI)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-check-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 and reports no cycles on an acyclic project', async () => {
    await indexProject(dir, {
      'src/c.ts': "import { d } from './d';\nexport function c() { return d(); }\n",
      'src/d.ts': "export function d() { return 42; }\n",
    });

    const res = run(dir);
    expect(res.code).toBe(0);
    expect(res.stdout.toLowerCase()).toContain('no circular');
  });

  it('exits non-zero and names both files when a cycle exists', async () => {
    await indexProject(dir, {
      'src/a.ts': "import { b } from './b';\nexport function a() { return b(); }\n",
      'src/b.ts': "import { a } from './a';\nexport function b() { return a(); }\n",
    });

    const res = run(dir);
    // Cycle present → non-zero exit (git-hook ready).
    expect(res.code).not.toBe(0);
    // Output names both members of the cycle (asserted on stdout content so
    // this fails for the right reason pre-implementation, not just exit code).
    expect(res.stdout).toContain('src/a.ts');
    expect(res.stdout).toContain('src/b.ts');
  });
});
