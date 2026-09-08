/**
 * Deep-nesting safety for the native kernel (#1581).
 *
 * The kernel's per-language walkers recurse once per AST level. tree-sitter's
 * parser is iterative, so a pathologically nested file — clang's
 * `clang/test/Parser/parser_overflow.c` nests 16,384 `{`; fuzzer corpora go
 * deeper — parses fine and then overflowed the WALKER's native stack. A native
 * overflow is uncatchable: the parse worker is a thread of the `codegraph`
 * process, so the SIGSEGV killed the whole indexer with no message, no partial
 * index, no per-file fallback. Worker threads get Node's 4 MiB default stack;
 * the 8 MiB main thread only moved the cliff (100k levels still died).
 *
 * The kernel now guards its recursion against the calling thread's real stack
 * bounds (codegraph-kernel/src/stack.rs) and turns an imminent overflow into
 * its `defer:` routing signal, so the file takes the wasm path — whose walker
 * catches its own JS `RangeError` per file and stores a partial result with a
 * `parse_error`. These tests pin that contract on every default-routed
 * language, on the main thread AND inside a default-sized worker, and
 * end-to-end through the built CLI.
 *
 * Like the other kernel suites: skipped without a staged .node; CI that
 * builds the kernel sets CODEGRAPH_KERNEL_EXPECT=1 so a missing binary FAILS.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Worker } from 'worker_threads';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { kernelRoutes, resetKernelForTests } from '../src/extraction/kernel';
import type { Language } from '../src/types';

const REPO = path.resolve(__dirname, '..');
const KERNEL_PATH = path.join(
  REPO,
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);
const expectKernel = process.env.CODEGRAPH_KERNEL_EXPECT === '1';
const BIN = path.join(REPO, 'dist', 'bin', 'codegraph.js');
const DIST_KERNEL = path.join(REPO, 'dist', 'extraction', 'kernel');
const distBuilt = fs.existsSync(BIN) && fs.existsSync(path.join(DIST_KERNEL, 'index.js'));

/** Deep enough to overflow an 8 MiB main-thread stack on every walker. */
const PARENS_DEPTH = 60_000;
/** The reporter's exact shape: clang's parser_overflow.c nests 16,384 `{`. */
const BRACES_DEPTH = 16_384;

const CANDIDATES: Language[] = [
  'typescript', 'tsx', 'javascript', 'jsx', 'java', 'python', 'go', 'c', 'cpp',
  'rust', 'csharp', 'ruby', 'php', 'swift', 'kotlin', 'r', 'lua', 'luau', 'scala', 'dart',
];

const EXT: Record<string, string> = {
  typescript: 'ts', tsx: 'tsx', javascript: 'js', jsx: 'jsx', java: 'java', python: 'py',
  go: 'go', c: 'c', cpp: 'cpp', rust: 'rs', csharp: 'cs', ruby: 'rb', php: 'php',
  swift: 'swift', kotlin: 'kt', r: 'R', lua: 'lua', luau: 'luau', scala: 'scala', dart: 'dart',
};

/** A function `f` whose body is a `depth`-deep parenthesized expression. */
function deepParens(language: Language, depth: number): string {
  const open = '('.repeat(depth);
  const close = ')'.repeat(depth);
  switch (language) {
    case 'typescript': case 'tsx': case 'javascript': case 'jsx':
      return `function f() { return ${open}1${close}; }\n`;
    case 'java':
      return `class A {\n  int f() { return ${open}1${close}; }\n}\n`;
    case 'python':
      return `def f():\n    return ${open}1${close}\n`;
    case 'go':
      return `package p\n\nfunc f() int { return ${open}1${close} }\n`;
    case 'c':
      return `int f(void) { return ${open}1${close}; }\n`;
    case 'cpp':
      return `int f() { return ${open}1${close}; }\n`;
    case 'rust':
      return `fn f() -> i32 { ${open}1${close} }\n`;
    case 'csharp':
      return `class A {\n  int f() { return ${open}1${close}; }\n}\n`;
    case 'ruby':
      return `def f\n  ${open}1${close}\nend\n`;
    case 'php':
      return `<?php\nfunction f() { return ${open}1${close}; }\n`;
    case 'swift':
      return `func f() -> Int { return ${open}1${close} }\n`;
    case 'kotlin':
      return `fun f(): Int { return ${open}1${close} }\n`;
    case 'r':
      return `f <- function() {\n  ${open}1${close}\n}\n`;
    case 'lua': case 'luau':
      return `local function f()\n  return ${open}1${close}\nend\n`;
    case 'scala':
      return `object A {\n  def f(): Int = ${open}1${close}\n}\n`;
    case 'dart':
      return `int f() { return ${open}1${close}; }\n`;
    default:
      throw new Error(`no deep fixture for ${language}`);
  }
}

/** The reporter's repro: a C function body of `depth` nested blocks. */
function deepBraces(depth: number): string {
  return `void foo(void) {\n${'{'.repeat(depth)}${'}'.repeat(depth)}\n}\n`;
}

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS', 'CODEGRAPH_KERNEL_PATH'] as const;
let savedEnv: Record<string, string | undefined>;

describe.skipIf(!kernelBuilt)('kernel deep-nesting guard (#1581)', () => {
  let routed: Language[] = [];

  beforeAll(async () => {
    resetKernelForTests();
    routed = CANDIDATES.filter((l) => kernelRoutes(l));
    expect(routed.length).toBeGreaterThan(0);
    await initGrammars();
    await loadGrammarsForLanguages(routed);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  it('every default-routed language survives a 60k-deep expression on the main thread', () => {
    const failures: string[] = [];
    for (const language of routed) {
      const file = `deep.${EXT[language]}`;
      const source = deepParens(language, PARENS_DEPTH);
      // The ONLY acceptable outcomes: a clean result (the thread's stack was
      // big enough for the walk), or the wasm fallback's partial result with
      // its parse_error. A native overflow would have killed this process.
      const result = extractFromSource(file, source, language);
      const fn = result.nodes.find((n) => n.name === 'f' && (n.kind === 'function' || n.kind === 'method'));
      // R's wasm walker mints `f <- function()` only after walking the
      // assignment's value, so its partial result for a file this deep holds
      // just the file node — the same shape main's wasm-only path produces
      // (verified with CODEGRAPH_KERNEL=0). Pre-existing and out of scope
      // here; what this test pins for R is that the process survives.
      if (!fn && language !== 'r') failures.push(`${language}: no function node 'f' (nodes=${result.nodes.map((n) => `${n.kind}:${n.name}`).join(',')})`);
      for (const e of result.errors) {
        if (!/Maximum call stack|parse_error|Parse error/.test(`${e.code} ${e.message}`)) {
          failures.push(`${language}: unexpected error ${e.message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it("the reporter's 16,384-brace C file is indexed (partial) instead of killing the process", () => {
    const result = extractFromSource('deep.c', deepBraces(BRACES_DEPTH), 'c');
    expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'foo')).toBe(true);
  }, 60_000);

  it('shallow files still take the kernel path (the guard never trips on normal code)', () => {
    // Sanity for the perf-neutral claim: a 200-deep expression is far inside
    // any thread's stack, so it must come back clean with no parse_error.
    for (const language of routed) {
      const result = extractFromSource(`ok.${EXT[language]}`, deepParens(language, 200), language);
      expect(result.errors, language).toEqual([]);
      expect(result.nodes.some((n) => n.name === 'f'), language).toBe(true);
    }
  }, 60_000);

  describe.skipIf(!distBuilt)('inside a default-sized (4 MiB) parse worker, through dist/', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deep-'));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    /**
     * Run the kernel's raw extraction for `file` inside a Worker with Node's
     * DEFAULT resourceLimits — exactly how ParseWorkerPool runs it. Resolves
     * with the worker's exit code and what it reported; a native overflow
     * would SIGSEGV/SIGILL this whole vitest process instead.
     */
    function runInWorker(file: string, source: string, language: Language): Promise<{ exitCode: number; outcome: string }> {
      const script = path.join(tmp, 'worker.cjs');
      fs.writeFileSync(
        script,
        [
          `const { parentPort, workerData } = require('worker_threads');`,
          `const { tryKernelExtractRaw } = require(${JSON.stringify(DIST_KERNEL)});`,
          `const raw = tryKernelExtractRaw(workerData.file, workerData.source, workerData.language);`,
          `parentPort.postMessage(raw ? 'kernel:' + raw.counts.nodes : 'deferred');`,
        ].join('\n')
      );
      return new Promise((resolve, reject) => {
        let outcome = 'no message';
        const w = new Worker(script, { workerData: { file, source, language } });
        w.on('message', (m: string) => { outcome = m; });
        w.on('error', reject);
        w.on('exit', (exitCode) => resolve({ exitCode, outcome }));
      });
    }

    it("defers the reporter's deep.c instead of crashing the worker", async () => {
      const r = await runInWorker('deep.c', deepBraces(BRACES_DEPTH), 'c');
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe('deferred');
    }, 60_000);

    it('defers a 60k-deep expression in every default-routed language', async () => {
      for (const language of routed) {
        const r = await runInWorker(`deep.${EXT[language]}`, deepParens(language, PARENS_DEPTH), language);
        expect(r.exitCode, language).toBe(0);
        // Either the guard tripped (deferred) or the walk fit — never a crash.
        expect(['deferred', 'kernel'].some((p) => r.outcome.startsWith(p)), `${language}: ${r.outcome}`).toBe(true);
      }
    }, 180_000);

    it('still extracts a normal file natively in the worker', async () => {
      const r = await runInWorker('ok.c', 'int add(int a, int b) { return a + b; }\n', 'c');
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toMatch(/^kernel:/);
    }, 30_000);
  });

  describe.skipIf(!distBuilt)('end-to-end: codegraph init on a repo holding the deep file', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deep-cli-'));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('exits 0 and records deep.c alongside the normal files', () => {
      fs.writeFileSync(path.join(tmp, 'deep.c'), deepBraces(BRACES_DEPTH));
      fs.writeFileSync(path.join(tmp, 'ok.c'), 'int add(int a, int b) { return a + b; }\n');
      execFileSync(process.execPath, [BIN, 'init', '.'], {
        cwd: tmp,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
        env: {
          ...process.env,
          CODEGRAPH_NO_DAEMON: '1',
          CODEGRAPH_WASM_RELAUNCHED: '1',
          CODEGRAPH_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
          CODEGRAPH_NO_PROMPT_HOOK: '1',
        },
      });
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      const db = new DatabaseSync(path.join(tmp, '.codegraph', 'codegraph.db'), { readOnly: true });
      try {
        const files = (db.prepare('SELECT path FROM files ORDER BY path').all() as Array<{ path: string }>).map((r) => r.path);
        expect(files).toEqual(['deep.c', 'ok.c']);
        const fns = (db.prepare("SELECT name FROM nodes WHERE kind = 'function' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
        expect(fns).toEqual(['add', 'foo']);
      } finally {
        db.close();
      }
    }, 180_000);
  });
});

describe.skipIf(!expectKernel)('kernel presence (CODEGRAPH_KERNEL_EXPECT=1)', () => {
  it('the staged .node exists so the deep-nesting suite actually ran', () => {
    expect(kernelBuilt).toBe(true);
  });
});
