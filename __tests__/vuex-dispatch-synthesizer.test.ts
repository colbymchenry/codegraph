/**
 * Vuex string-keyed dispatch/commit bridge.
 *
 * Vuex dispatches actions/mutations by a runtime STRING key — `dispatch('user/login')`,
 * `commit('SET_TOKEN')` — with no static edge to the handler (an object-literal
 * method in a store module). This bridges the key to its function node: the last
 * `/` segment is the action/mutation name, the preceding segment is the namespace
 * (≈ the module file). It resolves to a node IN A STORE FILE (excluding a same-named
 * `api/` helper — a real collision), disambiguated by the namespace appearing in the
 * path, or the same file for a root `commit('M')` inside an action. Redux-style
 * `dispatch(actionCreator())` (no string key) produces nothing.
 *
 * Also exercises the canonical Vuex MODULE shape `export default { namespaced,
 * actions: {…}, mutations: {…} }` — whose methods only become nodes via the
 * store-collection extraction this bridge depends on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('vuex-dispatch synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vuex-dispatch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('bridges namespaced dispatch + local commit to the right store handler, excluding an api collision', async () => {
    fs.mkdirSync(path.join(dir, 'store', 'modules'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
    // Canonical Vuex module: `export default { namespaced, actions, mutations }`.
    fs.writeFileSync(
      path.join(dir, 'store', 'modules', 'user.js'),
      `import { login as apiLogin } from '../../api/user';
export default {
  namespaced: true,
  state: { token: '' },
  mutations: {
    SET_TOKEN(state, t) { state.token = t; },
  },
  actions: {
    login({ commit }, info) {
      apiLogin(info);
      commit('SET_TOKEN', info.token);   // root/local key → SET_TOKEN in THIS module
    },
  },
};
`
    );
    // Collision: an api helper ALSO named `login` — must never be the dispatch target.
    fs.writeFileSync(
      path.join(dir, 'api', 'user.js'),
      `export function login(info) { return info; }
`
    );
    // Consumer dispatches by namespaced string key.
    fs.writeFileSync(
      path.join(dir, 'app.js'),
      `import store from './store';
export function bootstrap() {
  store.dispatch('user/login', { token: 'x' });
}
`
    );
    // Redux-style control: a non-string dispatch must produce no vuex edge.
    fs.writeFileSync(
      path.join(dir, 'reduxy.js'),
      `export function reduxy(dispatch) {
  dispatch(someAction());
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db
      .prepare(
        `SELECT s.name source, t.name target, t.file_path tf, json_extract(e.metadata,'$.via') via
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'vuex-dispatch'`
      )
      .all();

    // bootstrap → login, resolving to the STORE module (not api/user.js).
    const loginEdge = edges.find((r: any) => r.source === 'bootstrap' && r.target === 'login');
    expect(loginEdge).toBeTruthy();
    expect(loginEdge.tf).toMatch(/store[\\/]modules[\\/]user\.js$/);
    expect(loginEdge.via).toBe('user/login');
    // The api helper of the same name was never targeted.
    expect(edges.some((r: any) => /api[\\/]user\.js$/.test(r.tf))).toBe(false);
    // Local commit('SET_TOKEN') inside the action → the same module's mutation.
    expect(edges.some((r: any) => r.source === 'login' && r.target === 'SET_TOKEN')).toBe(true);
    // Redux-style non-string dispatch contributed nothing.
    expect(edges.some((r: any) => r.source === 'reduxy')).toBe(false);

    cg.close?.();
  });
});
