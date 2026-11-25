/**
 * A Go method called on what a builtin hands back — `new(Route).Host("x")`,
 * `make(Set).Add(k)`, `append(list, x).Len()` — is a method of the type the
 * call writes (#3237). Both extractors encoded such a chain as a package
 * factory's, `new().Host`, which dropped the `Route` that types it, and the
 * resolver then took whichever `Host` sat nearest: gorilla/mux's route tests
 * (`new(Route).Host(…)`, `.Path(…)`, `.Queries(…)`) all reached `Router`'s
 * methods. `new` and `make` now keep the named type they write
 * (`new(Route).Host`), and the method is that type's, or nothing for a type
 * from outside the project; any other builtin call keeps the bare name, whose
 * receiver the resolver reads where the call is written.
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

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** The issue's module, plus decoys: `Router` sorts first, so the name alone found its methods. */
const FILES: Record<string, string> = {
  'go.mod': 'module example.com/p\n\ngo 1.22\n',
  'a_router.go': `package p

type Router struct{}

func (r *Router) Host(h string) *Router { return r }

func (r *Router) Path(p string) *Router { return r }

func (r *Router) Schemes(s string) *Route { return nil }

func (r *Router) Add(k string) {}

func (r *Router) Ping() {}

func (r *Router) Reticulate(s string) {}
`,
  'b_route.go': `package p

type Route struct{}

func (r *Route) Host(h string) *Route { return r }

func (r *Route) Path(p string) *Route { return r }

func (r *Route) Schemes(s string) *Route { return r }

func (r *Route) Subrouter() *Router { return nil }

type Set map[string]struct{}

func (s Set) Add(k string) { s[k] = struct{}{} }

type List []int

func (l List) Len() int { return len(l) }

type Base struct{}

func (b *Base) Ping() {}

type Derived struct{ Base }
`,
  'use.go': `package p

import (
	"github.com/acme/spline"

	"example.com/p/sub"
)

func viaNew() *Route {
	return new(Route).Host("x")
}

func viaLiteral() *Route {
	return (&Route{}).Host("y")
}

func viaVar() *Route {
	r := new(Route)
	return r.Host("z")
}

func viaNewChain() *Route {
	return new(Route).
		Host("x").
		Path("/p")
}

func viaPackage() *sub.Route {
	return new(sub.Route).Host("w")
}

func viaMake() {
	make(Set).Add("k")
}

func viaAppend(list List) int {
	return append(list, 1).Len()
}

func viaEmbedded() {
	new(Derived).Ping()
}

func viaRepeated() *Route {
	return new(Route).Schemes("https").Subrouter().Schemes("ftp")
}

func viaOutside() {
	new(spline.Reticulator).Reticulate("x")
}
`,
  'sub/route.go': `package sub

type Route struct{}

func (r *Route) Host(h string) *Route { return r }
`,
};

describe('Go calls on a builtin call are recorded with the type it writes (#3237)', () => {
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
      return extractFromSource('use.go', source, 'go');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('use.go', source, 'go');
    expect(result, 'kernel extraction').not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  it.each(backends)('`new(T).M` and `make(T).M`; the bare name for any other builtin call: %s', (backend) => {
    const source = `package p

func f(list List) {
	new(Route).Host("x")
	make(pkg.Set, 8).Add("k")
	_ = append(list, 1).Len()
	New().Host("y")
	new(List[ int ]).Len()
	new(*Route).Host("z")
}
`;
    const refs = extract(backend, source).unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => `${r.referenceName} ${r.line}:${r.column}`)
      .sort();
    expect(refs).toEqual([
      'new(Route).Host 4:1',
      'make(pkg.Set).Add 5:1',
      'Len 6:5',
      // A package's own factory keeps its shape: the resolver reads what `New` returns.
      'New().Host 7:1',
      'new(List[int]).Len 8:1',
      // A pointer type has no methods of its own.
      'Host 9:1',
      // The builtin calls themselves.
      'new 4:1',
      'make 5:1',
      'append 6:5',
      'New 7:1',
      'new 8:1',
      'new 9:1',
    ].sort());
  });
});

describe.each(['default', 'wasm'])('Go calls on a builtin call resolve on the type it writes (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-new-recv-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  /** `<line> <target file>::<target qualified name>` for every call the function `name` in use.go makes. */
  function calls(name: string): string[] {
    const fn = cg!.getNodesInFile('use.go').find((n) => n.name === name && n.kind === 'function');
    expect(fn, name).toBeDefined();
    return cg!
      .getOutgoingEdges(fn!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => `${e.line} ${cg!.getNode(e.target)!.filePath}::${cg!.getNode(e.target)!.qualifiedName}`)
      .sort();
  }

  it("links the issue's `new(Route).Host` to Route's method, as the literal and the local already were", () => {
    expect(calls('viaNew')).toEqual(['10 b_route.go::Route::Host']);
    expect(calls('viaLiteral')).toEqual(['14 b_route.go::Route::Host']);
    expect(calls('viaVar')).toEqual(['19 b_route.go::Route::Host']);
  });

  it('follows the chain on to the method the first link returns', () => {
    expect(calls('viaNewChain')).toEqual(['23 b_route.go::Route::Host', '23 b_route.go::Route::Path']);
  });

  it('reads a type written through a project package', () => {
    expect(calls('viaPackage')).toEqual(['29 sub/route.go::Route::Host']);
  });

  it('types `make` and `append` the same way', () => {
    expect(calls('viaMake')).toEqual(['33 b_route.go::Set::Add']);
    expect(calls('viaAppend')).toEqual(['37 b_route.go::List::Len']);
  });

  it('reaches a method embedding promotes into the type', () => {
    expect(calls('viaEmbedded')).toEqual(['41 b_route.go::Base::Ping']);
  });

  it('tells the first link from a later one of the same name', () => {
    expect(calls('viaRepeated')).toEqual([
      '45 a_router.go::Router::Schemes',
      '45 b_route.go::Route::Schemes',
      '45 b_route.go::Route::Subrouter',
    ]);
  });

  it("links nothing for a type from outside the project, rather than a namesake's method", () => {
    expect(calls('viaOutside')).toEqual([]);
  });
});
