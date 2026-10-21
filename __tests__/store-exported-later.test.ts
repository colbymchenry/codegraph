/**
 * A store exported by a LATER statement — `const useStore = create(…)` then
 * `export default useStore` — is exported, and its actions are extracted like
 * an `export const` store's (object-literal-methods.test.ts covers that
 * form). The scope rule that keeps inline-object noise out still holds: a
 * store nothing exports stays a constant.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const fnNames = (code: string, file = 'store.ts') =>
  extractFromSource(file, code)
    .nodes.filter((n) => n.kind === 'function')
    .map((n) => n.name);

describe('store actions on a later-exported const', () => {
  it('export default NAME', () => {
    const code = `
      import { create } from 'zustand'
      const useCaptureStorage = create<State>((set, get) => ({
        object: null,
        setSettings: (settings: Settings) => {
          set({ settings })
        },
        reset: () => set({ object: null }),
      }))
      export default useCaptureStorage
    `;
    expect(fnNames(code)).toEqual(expect.arrayContaining(['setSettings', 'reset']));
  });

  it('export { NAME } and export { NAME as default }', () => {
    const named = `
      const useStore = create((set) => ({ bump: () => set({}) }))
      export { useStore }
    `;
    const asDefault = `
      const useStore = create((set) => ({ bump: () => set({}) }))
      export { useStore as default }
    `;
    expect(fnNames(named)).toContain('bump');
    expect(fnNames(asDefault)).toContain('bump');
  });

  it.each([
    ['items$', 'export { items$ };', true],
    ['$items', 'export { $items as default };', true],
    ['items', 'export { items$ };', false],
    ['items', 'export { $items };', false],
  ] as const)('an export clause names %s only whole: `%s`', (name, exportLine, kept) => {
    // A `$` belongs to the name: `items$` is exported, `items` is not.
    const code = `
      const ${name} = create((set) => ({ inc: () => set({}) }))
      ${exportLine}
    `;
    expect(fnNames(code).includes('inc')).toBe(kept);
  });

  it('a const nothing exports keeps its members out of the graph', () => {
    const code = `
      const useStore = create((set) => ({ bump: () => set({}) }))
      export const other = 1
    `;
    expect(fnNames(code)).not.toContain('bump');
  });

  it('is not fooled by a different name in the export', () => {
    const code = `
      const useStoreInternal = create((set) => ({ bump: () => set({}) }))
      const useStore = 1
      export default useStore
    `;
    expect(fnNames(code)).not.toContain('bump');
  });
});
