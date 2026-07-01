/**
 * Pinia `useStore().action()` dispatch bridge.
 *
 * A Pinia store factory `export const useXStore = defineStore(...)` exposes its
 * actions as methods on the store instance; a consumer does `const s = useXStore()`
 * then `s.action()`. That method-on-instance call has no static edge to the action
 * (which lives in the store module). This bridges consumer → action by binding the
 * store var to its factory's file and resolving `s.method()` to a function node IN
 * THAT FILE — so it covers both the options and setup store forms, stays precise
 * (a Pinia built-in like `$patch`, or an unrelated same-named method, resolves to
 * nothing), and fires only when a `defineStore` factory actually exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('pinia-store synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinia-store-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('bridges `const s = useXStore(); s.action()` to the action, across options + setup forms', async () => {
    // Options-form store.
    fs.writeFileSync(
      path.join(dir, 'authStore.ts'),
      `import { defineStore } from 'pinia';
export const useAuthStore = defineStore({
  id: 'auth',
  state: () => ({ token: '' }),
  actions: {
    async getMenu() { return loadMenu(); },
    setToken(t: string) { this.token = t; },
  },
});
`
    );
    // Setup-form store.
    fs.writeFileSync(
      path.join(dir, 'chatStore.ts'),
      `import { defineStore } from 'pinia';
export const useChatStore = defineStore('chat', () => {
  const getList = async () => { return fetchList(); };
  return { getList };
});
`
    );
    // Consumer binds both stores and calls their actions (plus a Pinia built-in).
    fs.writeFileSync(
      path.join(dir, 'init.ts'),
      `import { useAuthStore } from './authStore';
import { useChatStore } from './chatStore';
export function init() {
  const authStore = useAuthStore();
  const chatStore = useChatStore();
  authStore.getMenu();
  authStore.setToken('x');
  authStore.$patch({});        // Pinia built-in — must not bridge
  chatStore.getList();
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db
      .prepare(
        `SELECT s.name source, t.name target, t.file_path tf
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'pinia-store'`
      )
      .all();
    const pairs = edges.map((r: any) => `${r.source}->${r.target}`).sort();
    // Exactly the three real actions, all from `init`.
    expect(pairs).toEqual(['init->getList', 'init->getMenu', 'init->setToken']);
    // Each target is the action in its own store file (cross-file, store-scoped).
    expect(edges.every((r: any) => /Store\.ts$/.test(r.tf))).toBe(true);
    // The Pinia built-in `$patch` produced no edge.
    expect(pairs.some((p: string) => p.includes('patch'))).toBe(false);

    cg.close?.();
  });

  it('produces nothing when there is no defineStore factory (not a Pinia store)', async () => {
    fs.writeFileSync(
      path.join(dir, 'thing.ts'),
      `function useThing() { return { run() { return 1; } }; }
export function go() {
  const thing = useThing();
  thing.run();
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const c = db
      .prepare(`SELECT count(*) c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'pinia-store'`)
      .get().c;
    expect(c).toBe(0);

    cg.close?.();
  });
});
