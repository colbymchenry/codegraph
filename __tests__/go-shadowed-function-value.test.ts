/**
 * A Go function used as a value is recorded once per function, at its first
 * use (#756). Since #2658 a use that a parameter or local of the same name
 * shadows links to nothing, which is right for that use. But when the first
 * use in a function is the shadowed one and a later use, outside the local's
 * scope, is the package function, the later use had no reference left: the
 * function lost its `references` edge to the package function (#2596).
 *
 * A function that binds the name itself now records one use per scope (a
 * block, a statement's implicit block, a case clause), so the later use keeps
 * its own reference. Within one scope a local declared before the first use
 * covers every later use as well, so the first use still speaks for the
 * scope. A function that binds no such local keeps its single reference, and
 * so does one whose own parameter has the name: that covers the whole body.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const GO_MOD = 'module example.com/app\n\ngo 1.22\n';

/** Line numbers are pinned by the assertions below: keep the layout. */
const MAIN_GO = `package main

func run(a, b int) int { return a + b }

func apply(f any) {}

func pick(f any) any { return f }

func shadowThenUse(x int) {
	if x > 0 {
		run := 2
		_ = run
	}
	apply(run)
}

func closureThenUse() {
	g := func(run int) { _ = run }
	g(1)
	apply(run)
}

func caseThenUse(x int) {
	switch x {
	case 1:
		run := 3
		_ = run
	case 2:
		apply(run)
	}
}

func headerThenUse() {
	if run := pick(nil); run != nil {
		_ = run
	}
	apply(run)
}

func rangeThenUse(xs []int) {
	for _, run := range xs {
		_ = run
	}
	apply(run)
}

func useThenShadow(x int) {
	apply(run)
	if x > 0 {
		run := 2
		_ = run
	}
	apply(run)
}

func allShadowed(run func(int, int) int) {
	apply(run)
	if true {
		apply(run)
	}
}

func noBinding(x int) {
	apply(run)
	if x > 0 {
		apply(run)
	}
}

func paramValue(run func(int, int) int) {
	apply(run)
}

func localValue() {
	run := 1
	_ = run
}

func main() {}

var literalThenUse = func(x int) {
	if x > 0 {
		run := 2
		_ = run
	}
	apply(run)
}
`;

/** `<function> L<line>` for every function_ref ref to `run`, in source order. */
function runRefs(result: ExtractionResult): string[] {
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === 'function_ref' && r.referenceName === 'run')
    .map((r) => `${byId.get(r.fromNodeId)?.name} L${r.line}`);
}

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('a Go function value keeps its reference past a shadowing local (#2596)', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['go']);
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

  function extract(backend: 'kernel' | 'wasm', source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource('main.go', source, 'go');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('main.go', source, 'go');
    expect(result, 'kernel extraction of main.go').not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const source = crlf ? MAIN_GO.replace(/\n/g, '\r\n') : MAIN_GO;
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`records a use per scope only where the function binds the name: %s${label}`, (backend) => {
      expect(runRefs(extract(backend, source))).toEqual([
        // Binds `run` in a scope of its own: one use per scope.
        'shadowThenUse L12',
        'shadowThenUse L14',
        'closureThenUse L18',
        'closureThenUse L20',
        'caseThenUse L27',
        'caseThenUse L29',
        'headerThenUse L35',
        'headerThenUse L37',
        'rangeThenUse L42',
        'rangeThenUse L44',
        // The function body's two uses are one scope: the first speaks for both.
        'useThenShadow L48',
        'useThenShadow L51',
        // A parameter of the function itself covers its whole body: one use.
        'allShadowed L57',
        // Binds no `run`: one use per function, as before.
        'noBinding L64',
        'paramValue L71',
        'localValue L76',
        // A func literal at file scope is its own unit.
        'literalThenUse L84',
        'literalThenUse L86',
      ]);
    });
  }

  it.runIf(kernelAvailable)('the kernel and the wasm extractor record the same references', () => {
    const kernel = extract('kernel', MAIN_GO);
    const wasm = extract('wasm', MAIN_GO);
    const refs = (r: ExtractionResult) =>
      r.unresolvedReferences.map((u) => `${u.referenceKind} ${u.referenceName} ${u.line}:${u.column}`);
    expect(refs(kernel)).toEqual(refs(wasm));
  });
});

describe('the references a function keeps to the package function (#2596)', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2596-'));
    fs.writeFileSync(path.join(tempDir, 'go.mod'), GO_MOD);
    fs.writeFileSync(path.join(tempDir, 'main.go'), MAIN_GO);
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();
  }, 120_000);

  afterAll(() => {
    cg?.close();
    cg = null;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** `L<line>` of each `references` edge from `fromName` to the package `func run`. */
  function refsToRun(fromName: string, kind: 'function' | 'variable' = 'function'): string[] {
    const from = cg!.getNodesByKind(kind).find((n) => n.name === fromName);
    expect(from, fromName).toBeDefined();
    return cg!
      .getOutgoingEdges(from!.id)
      .filter((e) => e.kind === 'references')
      .filter((e) => {
        const target = cg!.getNode(e.target);
        return target?.kind === 'function' && target.name === 'run';
      })
      .map((e) => `L${e.line}`)
      .sort();
  }

  it.each([
    ['an inner block local', 'shadowThenUse', 'L14'],
    ['a func literal parameter', 'closureThenUse', 'L20'],
    ['a local in another case clause', 'caseThenUse', 'L29'],
    ['an if-header local', 'headerThenUse', 'L37'],
    ['a range variable', 'rangeThenUse', 'L44'],
  ])('a later use outside %s links to the package function', (_label, fn, line) => {
    expect(refsToRun(fn)).toEqual([line]);
  });

  it('a later use in a func literal at file scope links to the package function', () => {
    expect(refsToRun('literalThenUse', 'variable')).toEqual(['L86']);
  });

  it('a function whose first use is the package function keeps that one reference', () => {
    expect(refsToRun('useThenShadow')).toEqual(['L48']);
  });

  it('a function that binds no local of the name keeps its single reference', () => {
    expect(refsToRun('noBinding')).toEqual(['L64']);
  });

  it('no use the local shadows links to the package function', () => {
    expect(refsToRun('allShadowed')).toEqual([]);
    expect(refsToRun('paramValue')).toEqual([]);
    expect(refsToRun('localValue')).toEqual([]);
  });
});
