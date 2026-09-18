import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

const projects: { dir: string; cg: CodeGraph }[] = [];
afterEach(() => {
  for (const { dir, cg } of projects.splice(0)) {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function consumer(active: boolean): string {
  return `import { useStore as current } from './store';
export function run() {
  const { reset } = ${active ? 'current.getState()' : 'external()'};
  reset();
  reset();
}
export function effects(client: any) {
  client.user.create();
  client?.user?.create();
}
`;
}

async function project(active: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-store-cache-'));
  fs.writeFileSync(path.join(dir, 'store.ts'), `import { create } from 'zustand';
export const useStore = create((set) => ({ reset: () => set({}) }));
`);
  fs.writeFileSync(path.join(dir, 'decoy.ts'), 'export function reset() { return 99; }');
  fs.writeFileSync(path.join(dir, 'consumer.ts'), consumer(active));
  const cg = CodeGraph.initSync(dir);
  projects.push({ dir, cg });
  const result = await cg.indexAll();
  expect(result.success).toBe(true);
  expect(result.filesErrored).toBe(0);
  return { dir, cg };
}

function assertBindings(cg: CodeGraph, active: boolean) {
  const functions = cg.getNodesByKind('function');
  const run = functions.find(n => n.name === 'run' && n.filePath === 'consumer.ts')!;
  const action = functions.find(n => n.name === 'reset' && n.filePath === 'store.ts')!;
  const decoy = functions.find(n => n.name === 'reset' && n.filePath === 'decoy.ts')!;
  const targets = cg.getOutgoingEdges(run.id).filter(e => e.kind === 'calls').map(e => e.target);
  expect(targets.includes(action.id)).toBe(active);
  expect(targets).not.toContain(decoy.id);
  const pendingActions = cg.getUnresolvedReferencesFrom(run.id).filter(r => r.referenceName === 'reset');
  expect(pendingActions).toHaveLength(active ? 0 : 2);

  // Eligibility must not remove untyped qualified call-site evidence, including
  // repeated/optional chains, or turn it into a guessed edge.
  const effects = functions.find(n => n.name === 'effects' && n.filePath === 'consumer.ts')!;
  expect(cg.getOutgoingEdges(effects.id).filter(e => e.kind === 'calls')).toEqual([]);
  expect(cg.getUnresolvedReferencesFrom(effects.id).filter(r => r.referenceKind === 'calls')
    .map(r => [r.referenceName, r.line, r.column])).toEqual([
      ['client.user.create', 8, 2], ['client.user.create', 9, 2],
    ]);
}

describe('store eligibility cache across edits and resolver contexts', () => {
  it.each([false, true])('sync refreshes eligibility starting with getState=%s', async (initial) => {
    const { dir, cg } = await project(initial);
    assertBindings(cg, initial);
    // Reuse the same CodeGraph/resolver and path in both directions. A cached
    // negative must not mask a new store binding, and removing it must remove
    // both action edges while preserving unresolved call-site evidence.
    for (const active of [!initial, initial]) {
      fs.writeFileSync(path.join(dir, 'consumer.ts'), consumer(active));
      const result = await cg.sync();
      expect(result.filesModified).toBe(1);
      assertBindings(cg, active);
    }
  }, 60000);

  it('does not share eligibility between projects with the same relative file path', async () => {
    const absent = await project(false);
    const present = await project(true);
    assertBindings(absent.cg, false);
    assertBindings(present.cg, true);
  }, 60000);
});
