/**
 * A Go package-level variable or constant is exported by its own name's case,
 * as a function or a type is:
 *
 *   var Hook = func() int { return 1 }   // exported
 *   var (
 *   	GroupedHook = func() int { return 2 }   // exported
 *   	grouped     = 0                         // package-local
 *   )
 *   const Limit = 3                      // exported
 *
 * Both extractors read exportedness off the declaration node, which has no
 * name (the names sit on its `var_spec` / `const_spec` children), so every
 * var and const was unexported. Another package's `a.Hook()` then found no
 * exported `Hook` in package `a` and linked to nothing, though a call from
 * inside the package linked to the variable.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
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

const PACKAGE_A = `package a

// Hook is a package-level function value.
var Hook = func() int { return 1 }

var (
	// GroupedHook sits in a var group.
	GroupedHook = func() int { return 2 }
	grouped     = 0
)

var hidden = func() int { return 3 }

var Typed, second int

const Limit = 3

const (
	ModeA = iota
	modeB
)

type Client struct{}

func (c *Client) Do() int { return 4 }

func helper() int { return Hook() + hidden() + grouped }
`;

const PACKAGE_B = `package b

import "example.com/app/a"

func Use() int {
	return a.Hook() + a.GroupedHook() + a.Limit + a.hidden()
}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Go package-level variables and constants are exported by their name', () => {
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
      return extractFromSource('a/a.go', source, 'go');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('a/a.go', source, 'go');
    expect(result, 'kernel extraction').not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    it.each(backends)(`%s${crlf ? ' (CRLF)' : ''}`, (backend) => {
      const result = extract(backend, crlf ? PACKAGE_A.replace(/\n/g, '\r\n') : PACKAGE_A);
      const exported = Object.fromEntries(
        result.nodes
          .filter((n) => n.kind === 'variable' || n.kind === 'constant')
          .map((n) => [`${n.kind} ${n.name}`, n.isExported])
      );
      // Every spec's node says, as a boolean, whether its name is exported.
      expect(exported).toEqual({
        'variable Hook': true,
        'variable GroupedHook': true,
        'variable grouped': false,
        'variable hidden': false,
        'variable Typed': true,
        'constant Limit': true,
        'constant ModeA': true,
        'constant modeB': false,
      });
      // Functions, methods and types keep theirs.
      const flag = (kind: string, name: string) => result.nodes.find((n) => n.kind === kind && n.name === name)?.isExported;
      expect(flag('struct', 'Client')).toBe(true);
      expect(flag('method', 'Do')).toBe(true);
      expect(flag('function', 'helper')).toBe(false);
    });
  }
});

describe.each([
  ['default', 'LF'],
  ['wasm', 'LF'],
  ['default', 'CRLF'],
  ['wasm', 'CRLF'],
])('a call through another package reaches its exported variable (%s, %s)', (backend, eol) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-value-exported-'));
    const files: Record<string, string> = {
      'go.mod': 'module example.com/app\n\ngo 1.21\n',
      'a/a.go': PACKAGE_A,
      'b/b.go': PACKAGE_B,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), eol === 'CRLF' ? content.replace(/\n/g, '\r\n') : content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  const nodeNamed = (file: string, name: string) => {
    const nodes = cg!.getNodesInFile(file).filter((n) => n.name === name && n.kind !== 'import');
    expect(nodes, `${name} in ${file}`).toHaveLength(1);
    return nodes[0]!;
  };

  /** `kind file:name` of each call out of `name` in `file`, sorted. */
  const callsFrom = (file: string, name: string) =>
    cg!.getOutgoingEdgesFrom([nodeNamed(file, name).id])
      .filter((e) => e.kind === 'calls')
      .map((e) => `${e.kind} ${cg!.getNode(e.target)!.filePath}:${cg!.getNode(e.target)!.name}`)
      .sort();

  it('a.Hook() and a.GroupedHook() call the variables package a exports', () => {
    expect(callsFrom('b/b.go', 'Use')).toEqual([
      'calls a/a.go:GroupedHook',
      'calls a/a.go:Hook',
    ]);
  });

  it('an unexported variable stays inside its package', () => {
    const unresolved = cg!.getUnresolvedReferencesFrom(nodeNamed('b/b.go', 'Use').id)
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(unresolved).toEqual(['a.hidden']);
  });

  it('calls inside the package still reach its variables', () => {
    expect(callsFrom('a/a.go', 'helper')).toEqual([
      'calls a/a.go:Hook',
      'calls a/a.go:hidden',
    ]);
  });
});
