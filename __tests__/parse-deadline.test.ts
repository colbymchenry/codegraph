/**
 * A parse that never ends is cancelled (#3274).
 *
 * tree-sitter 0.25.10's error recovery loops on some malformed input without
 * reading on: a half-typed JSX attribute, `<a {{b:>c:d(e f)` in a .tsx file,
 * never finished parsing. Indexing killed the parse worker at its hard
 * timeout, but a native kernel parse can't be killed that way: its thread kept
 * spinning, so `codegraph init` printed Done and never exited. And a sync,
 * the file watcher's too, parses on the process's own thread, which spun for
 * good. Every indexing parse now runs within the file's budget
 * (`CODEGRAPH_PARSE_TIMEOUT_MS`), in the wasm extractor and the kernel alike,
 * and the file is recorded as a parse that timed out.
 *
 * Like the other kernel suites, the kernel cases skip without a staged .node.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { getKernel, kernelRoutes, resetKernelForTests } from '../src/extraction/kernel';

const REPO = path.resolve(__dirname, '..');
const KERNEL_PATH = path.join(REPO, 'codegraph-kernel', 'prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node');
const kernelBuilt = fs.existsSync(KERNEL_PATH);
const BIN = path.join(REPO, 'dist', 'bin', 'codegraph.js');
const distBuilt = fs.existsSync(BIN);

/** The issue's 16 bytes: a parse of them loops in tree-sitter 0.25.10's error recovery. */
const HANG = '<a {{b:>c:d(e f)';
/** One character less, and it parses at once (with an error). */
const NEAR = '<a {{b:>c:d(e)';
const OK = 'export function Ok() { return <div className="ok">ok</div>; }\n';
const BUDGET_MS = 400;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_PARSE_TIMEOUT_MS'] as const;
let savedEnv: Record<string, string | undefined>;

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['tsx']);
});

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.CODEGRAPH_PARSE_TIMEOUT_MS = String(BUDGET_MS);
  resetKernelForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetKernelForTests();
});

/** extractFromSource, timed. */
function extract(file: string, source: string): { result: ReturnType<typeof extractFromSource>; ms: number } {
  const t0 = Date.now();
  const result = extractFromSource(file, source, 'tsx');
  return { result, ms: Date.now() - t0 };
}

function expectTimedOut(result: ReturnType<typeof extractFromSource>): void {
  expect(result.nodes).toEqual([]);
  expect(result.errors.map((e) => e.message)).toEqual([`Parse timed out after ${BUDGET_MS}ms`]);
  expect(result.errors[0]!.code).toBe('parse_error');
}

describe('an indexing parse runs within its budget (#3274)', () => {
  it('cancels the wasm parse that never ends, and the next parse starts afresh', () => {
    process.env.CODEGRAPH_KERNEL = '0';
    const hung = extract('src/poc.tsx', HANG);
    expectTimedOut(hung.result);
    expect(hung.ms).toBeLessThan(15_000);
    // The cancelled parse is not resumed by the next file's.
    const ok = extract('src/ok.tsx', OK);
    expect(ok.result.errors).toEqual([]);
    expect(ok.result.nodes.map((n) => `${n.kind} ${n.name}`)).toContain('function Ok');
    const near = extract('src/near.tsx', NEAR);
    expect(near.result.errors.map((e) => e.message).join('\n')).not.toContain('timed out');
  });

  it.skipIf(!kernelBuilt || process.env.CODEGRAPH_KERNEL === '0')('cancels the native parse that never ends, with no wasm retry', () => {
    expect(kernelRoutes('tsx')).toBe(true);
    const kernel = getKernel()!;
    expect(() => kernel.extractFile('src/poc.tsx', HANG, 'tsx', BUDGET_MS)).toThrow(/^timeout:/);
    // With room, or with no budget at all (an older caller), the kernel parses as before.
    expect(kernel.extractFile('src/ok.tsx', OK, 'tsx', 10_000).meta.length).toBeGreaterThan(0);
    expect(kernel.extractFile('src/ok.tsx', OK, 'tsx').meta.length).toBeGreaterThan(0);

    const hung = extract('src/poc.tsx', HANG);
    expectTimedOut(hung.result);
    // One budget, not a second one spent on the wasm path.
    expect(hung.ms).toBeLessThan(15_000);
    const ok = extract('src/ok.tsx', OK);
    expect(ok.result.errors).toEqual([]);
    expect(ok.result.nodes.map((n) => `${n.kind} ${n.name}`)).toContain('function Ok');
  });
});

describe.skipIf(!distBuilt)('the CLI finishes with a file whose parse never ends (#3274)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parse-deadline-'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'ok.tsx'), OK);
    fs.writeFileSync(path.join(tmp, 'src', 'poc.tsx'), HANG);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Run the CLI; a run that outlives `timeout` is killed, which `signal` then shows. */
  function cli(args: string[], kernel: boolean) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: tmp,
      encoding: 'utf-8',
      timeout: 120_000,
      env: {
        ...process.env,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_WASM_RELAUNCHED: '1',
        CODEGRAPH_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        CODEGRAPH_NO_PROMPT_HOOK: '1',
        CODEGRAPH_PARSE_TIMEOUT_MS: String(BUDGET_MS),
        CODEGRAPH_KERNEL: kernel ? '' : '0',
      },
    });
    return { ...r, ms: Date.now() - t0 };
  }

  for (const kernel of [true, false]) {
    it.skipIf(kernel && !kernelBuilt)(`init, index and sync exit on their own (${kernel ? 'kernel' : 'wasm'})`, () => {
      const init = cli(['init', '-y', '.'], kernel);
      expect(init.signal, init.stderr).toBeNull();
      expect(init.status, init.stderr).toBe(0);
      const log = fs.readFileSync(path.join(tmp, '.codegraph', 'errors.log'), 'utf-8');
      expect(log).toMatch(/src[\\/]poc\.tsx: Parse timed out after \d+ms/);

      const index = cli(['index', '.'], kernel);
      expect(index.signal, index.stderr).toBeNull();
      expect(index.status, index.stderr).toBe(0);

      // A sync parses on its own thread: the watcher's way.
      fs.writeFileSync(path.join(tmp, 'src', 'editing.tsx'), HANG);
      const sync = cli(['sync', '.'], kernel);
      expect(sync.signal, sync.stderr).toBeNull();
      expect(sync.status, sync.stderr).toBe(0);
    }, 300_000);
  }
});
