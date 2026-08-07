/**
 * Vue store action/mutation/getter extraction (the foundation for finding and
 * reading store logic — `codegraph_node login` / `getSessionList`).
 *
 * Vuex/Pinia define a store's callable surface as object-literal members nested
 * under `actions`/`mutations`/`getters`, or as body-local consts in a Pinia setup
 * store — none of which were extracted, so the symbols an agent looks for didn't
 * exist as nodes. This covers the three dominant forms:
 *   - Vuex module: non-exported `const actions = {…}` / `const mutations = {…}`.
 *   - Pinia options: `defineStore({ actions: {…}, getters: {…} })`.
 *   - Pinia setup: `defineStore('id', () => { const foo = …; return { foo } })`.
 * And the precision gate: a non-exported `const actions = {…}` in a file that
 * isn't a Vue store contributes nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('vue store extraction', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-store-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('extracts Vuex module + Pinia options + Pinia setup store members as function nodes', async () => {
    // Vuex MODULE form: non-exported `const mutations`/`const actions` collections,
    // wired via a default export (element-admin style). Method shorthand + arrow pairs.
    fs.writeFileSync(
      path.join(dir, 'userModule.js'),
      `import { persistToken } from './auth-utils';
const state = { token: '' };
const mutations = {
  SET_TOKEN: (state, token) => { state.token = token; },
};
const actions = {
  login({ commit }, info) {
    persistToken(info.token);
  },
  async logout({ commit }) {
    commit('SET_TOKEN', '');
  },
};
export default { namespaced: true, state, mutations, actions };
`
    );
    fs.writeFileSync(
      path.join(dir, 'auth-utils.js'),
      `export function persistToken(token) { return token; }
`
    );
    // Pinia OPTIONS form: actions + getters as object properties of a defineStore config.
    fs.writeFileSync(
      path.join(dir, 'authStore.ts'),
      `import { defineStore } from 'pinia';
export const useAuthStore = defineStore({
  id: 'auth',
  state: () => ({ name: '' }),
  getters: {
    upperName: state => state.name.toUpperCase(),
  },
  actions: {
    async fetchMenu() { return loadMenu(); },
    setName(n: string) { this.name = n; },
  },
});
`
    );
    // Pinia SETUP form: actions are body-local consts exposed via the return block.
    fs.writeFileSync(
      path.join(dir, 'chatStore.ts'),
      `import { defineStore } from 'pinia';
export const useChatStore = defineStore('chat', () => {
  const list = reactive([]);
  const getList = async () => { return fetchList(); };
  function pushItem(x) { list.push(x); }
  return { list, getList, pushItem };
});
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const fn = (name: string) =>
      db.prepare(`SELECT count(*) c FROM nodes WHERE name = ? AND kind = 'function'`).get(name).c;

    // Vuex module: actions + mutations extracted.
    expect(fn('login')).toBeGreaterThan(0);
    expect(fn('logout')).toBeGreaterThan(0);
    expect(fn('SET_TOKEN')).toBeGreaterThan(0);
    // Pinia options: actions + getter extracted.
    expect(fn('fetchMenu')).toBeGreaterThan(0);
    expect(fn('setName')).toBeGreaterThan(0);
    expect(fn('upperName')).toBeGreaterThan(0);
    // Pinia setup: body-local actions extracted (and reachable via their bodies).
    expect(fn('getList')).toBeGreaterThan(0);
    expect(fn('pushItem')).toBeGreaterThan(0);

    // The extracted action spans its real body — `login`'s `persistToken(...)`
    // call attributes to it (extraction, not the deferred dispatch synthesis).
    const loginCalls = db
      .prepare(
        `SELECT t.name FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.name = 'login' AND e.kind = 'calls'`
      )
      .all()
      .map((r: any) => r.name);
    expect(loginCalls).toContain('persistToken');

    cg.close?.();
  });

  it('does not extract a non-exported `const actions = {…}` outside a Vue store file', async () => {
    // A plain module that happens to hold a non-exported `const actions` object of
    // functions, but lacks any second Vue-store signal — the gate must not fire.
    fs.writeFileSync(
      path.join(dir, 'commands.js'),
      `const actions = {
  doThing() { return 1; },
  doOther() { return 2; },
};
export function run(key) { return actions[key](); }
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    expect(db.prepare(`SELECT count(*) c FROM nodes WHERE name = 'doThing'`).get().c).toBe(0);
    expect(db.prepare(`SELECT count(*) c FROM nodes WHERE name = 'doOther'`).get().c).toBe(0);
    // The real exported function is still extracted normally.
    expect(db.prepare(`SELECT count(*) c FROM nodes WHERE name = 'run' AND kind='function'`).get().c).toBeGreaterThan(0);

    cg.close?.();
  });
});
