/**
 * Object-literal method extraction (general AST rule).
 *
 * The extractor pulls function-valued properties out of an object literal that
 * is the value of an exported const — either DIRECTLY
 * (`export const actions = { foo: () => {} }`) or RETURNED by an initializer
 * call (`export const useStore = create((set, get) => ({ foo: () => {} }))`,
 * incl. middleware wrappers). This makes store actions (Zustand/Redux/Pinia/
 * MobX/handler maps) real nodes, so `codegraph_node`/`callers` on them resolve
 * instead of returning "not found" and forcing the agent to Read the store.
 *
 * Keyed purely on AST shape — no library names in the implementation — so any
 * same-shaped store is covered. Resolution then falls out of the existing
 * exact-name matcher: every call form (`const {foo}=useStore.getState(); foo()`,
 * `useStore.getState().foo()`, in-store `get().foo()`) reduces to a bare `foo`
 * call that resolves to the action node once it exists.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('object-literal method extraction', () => {
  it('extracts Zustand store actions (object returned by create()) as function nodes', () => {
    const code = `
      import { create } from 'zustand'
      interface Store {
        count: number
        fetchUser(): Promise<void>
        switchOrganization(id: string): Promise<void>
        reset(): void
      }
      export const useStore = create<Store>((set, get) => ({
        count: 0,
        fetchUser: async () => { await get().reset() },
        switchOrganization: async (id: string) => { set({ count: 1 }) },
        reset: () => set({ count: 0 }),
      }))
    `;
    const result = extractFromSource('store.ts', code);
    const fnNames = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(fnNames).toContain('fetchUser');
    expect(fnNames).toContain('switchOrganization');
    expect(fnNames).toContain('reset');

    // Each action's body was walked: fetchUser references its sibling `reset`,
    // so an in-store calls edge will resolve once the pipeline runs.
    const fetchUser = result.nodes.find((n) => n.name === 'fetchUser')!;
    const fetchUserRefs = result.unresolvedReferences.filter((r) => r.fromNodeId === fetchUser.id);
    expect(fetchUserRefs.map((r) => r.referenceName)).toContain('reset');

    // The action's body wasn't mis-attributed to the file scope (the reason we
    // skip the generic body-visit for the store-factory call).
    const fileNode = result.nodes.find((n) => n.kind === 'file')!;
    const fileRefs = result.unresolvedReferences.filter((r) => r.fromNodeId === fileNode.id);
    expect(fileRefs.map((r) => r.referenceName)).not.toContain('reset');
  });

  it('extracts actions through a middleware wrapper (create(persist(...)))', () => {
    const code = `
      import { create } from 'zustand'
      import { persist } from 'zustand/middleware'
      export const useCounter = create(
        persist(
          (set, get) => ({
            value: 0,
            increment: () => set({ value: get().value + 1 }),
          }),
          { name: 'counter' }
        )
      )
    `;
    const result = extractFromSource('counter.ts', code);
    const fnNames = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(fnNames).toContain('increment');
  });

  it('extracts actions when the initializer returns via a block (=> { return {...} })', () => {
    const code = `
      import { create } from 'zustand'
      export const useThing = create((set) => {
        const initial = 0
        return {
          value: initial,
          bump: () => set({ value: 1 }),
        }
      })
    `;
    const result = extractFromSource('thing.ts', code);
    const fnNames = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(fnNames).toContain('bump');
  });

  it('does NOT extract methods from a non-exported call-wrapped object (noise gate)', () => {
    const code = `
      function wrap(f: any) { return f }
      const local = wrap(() => ({ shouldNotExtract: () => {} }))
    `;
    const result = extractFromSource('inline.ts', code);
    const names = result.nodes.map((n) => n.name);
    expect(names).not.toContain('shouldNotExtract');
  });

  it('still extracts the existing direct-object shape (export const actions = {...})', () => {
    const code = `
      export const actions = {
        load: async () => { helper() },
      }
      function helper() {}
    `;
    const result = extractFromSource('actions.ts', code);
    const fnNames = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(fnNames).toContain('load');
  });
});

describe('object-literal method resolution (end-to-end)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves callers of store actions across files (destructured + chained getState())', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"t","dependencies":{"zustand":"^4"}}\n');
    fs.writeFileSync(
      path.join(tmpDir, 'store.ts'),
      `import { create } from 'zustand'\n` +
        `interface S { fetchUser(): Promise<void>; reset(): void }\n` +
        `export const useStore = create<S>((set, get) => ({\n` +
        `  fetchUser: async () => { get().reset() },\n` +
        `  reset: () => set({}),\n` +
        `}))\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'caller.ts'),
      `import { useStore } from './store'\n` +
        `export async function loginFlow() {\n` +
        `  const { fetchUser } = useStore.getState()\n` +
        `  await fetchUser()\n` +
        `}\n` +
        `export function hardReset() {\n` +
        `  useStore.getState().reset()\n` +
        `}\n`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const fetchUser = fns.find((n) => n.name === 'fetchUser' && n.filePath.endsWith('store.ts'));
    const reset = fns.find((n) => n.name === 'reset' && n.filePath.endsWith('store.ts'));
    expect(fetchUser).toBeDefined();
    expect(reset).toBeDefined();

    // Destructured-then-bare call: loginFlow -> fetchUser
    const fetchUserCallers = cg.getCallers(fetchUser!.id).map((c) => c.node.name);
    expect(fetchUserCallers).toContain('loginFlow');

    // Chained getState() call: hardReset -> reset, AND in-store sibling: fetchUser -> reset
    const resetCallers = cg.getCallers(reset!.id).map((c) => c.node.name);
    expect(resetCallers).toContain('hardReset');
    expect(resetCallers).toContain('fetchUser');

    cg.close();
  });
});
