/**
 * A function bound through a curried wrapper is named by its declarator (#1747).
 *
 * `react_hook_bound_name` already names an anonymous function after the
 * `variable_declarator` that binds it, but only when the callee is one of three
 * React hooks. The same shape with any other wrapper produced no function node
 * at all — and the loss is not only a missing node: the body's calls attribute
 * to the enclosing container instead, so a file or an outer function picks up an
 * outgoing edge that belongs to the function, and the callee's caller list names
 * the wrong thing.
 *
 * The bound used here is that the callee is itself a call — a factory that
 * returns the wrapper. That admits `Effect.fn("x")(fn)`, `connect(m)(fn)` and a
 * project's own `wrap("n")(fn)`, and leaves the single-call forms whose argument
 * is a computation (`useMemo`, `arr.map`) anonymous exactly as before.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const refsFrom = (result: ReturnType<typeof extractFromSource>, id: string) =>
  result.unresolvedReferences.filter((r) => r.fromNodeId === id).map((r) => r.referenceName);

const CODE = `
declare const Effect: { fn: (n: string) => (b: unknown) => unknown };
declare function connect(m: unknown): (c: unknown) => unknown;
declare function wrap(n: string): (c: unknown) => unknown;
declare function useMemo<T>(f: () => T, d: unknown[]): T;

function helper() { return 1; }

const viaEffectGen   = Effect.fn("Session.run")(function* () { return helper(); });
const viaEffectArrow = Effect.fn("Session.go")(() => { return helper(); });
const viaConnect     = connect({})(function () { return helper(); });
const viaWrapArrow   = wrap("n")(() => { return helper(); });

const total  = useMemo(() => 1 + 1, []);
const mapped = [1, 2].map(() => helper());
`;

describe('curried wrapper handlers', () => {
  it('names the wrapped function after its declarator, for every callee shape', () => {
    const result = extractFromSource('src/b.ts', CODE);
    const names = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);

    // A generator is the common form in the ecosystem this comes from, and it
    // is the shape the report opens with — `function*` is not accepted by
    // reactHookBoundName, so broadening the callee test alone would not fix it.
    expect(names).toContain('viaEffectGen');
    expect(names).toContain('viaEffectArrow');
    expect(names).toContain('viaConnect');
    expect(names).toContain('viaWrapArrow');
  });

  it('leaves single-call arguments anonymous, so the graph does not gain nodes for computations', () => {
    const result = extractFromSource('src/b.ts', CODE);
    const names = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);

    // The guard that makes the bound meaningful. `useMemo(() => …, [])` and
    // `arr.map(() => …)` are single calls whose argument is a computation; if
    // these ever start producing function nodes, the callee test has been
    // widened past what this change claims.
    expect(names).not.toContain('total');
    expect(names).not.toContain('mapped');
  });

  it('attributes the body calls to the function, not to the file', () => {
    const result = extractFromSource('src/b.ts', CODE);
    const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'viaEffectGen');
    expect(fn, 'no function node for viaEffectGen').toBeDefined();

    // The half of the report that a node count alone does not cover: the file
    // must not be the one calling helper.
    expect(refsFrom(result, fn!.id)).toContain('helper');
    const file = result.nodes.find((n) => n.kind === 'file');
    expect(file, 'no file node').toBeDefined();
    expect(refsFrom(result, file!.id)).not.toContain('helper');
  });
});
