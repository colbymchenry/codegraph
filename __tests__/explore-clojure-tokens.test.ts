/**
 * Explore query handling for Clojure / monorepo idioms.
 *
 * Covers the four layers of the explore token fix:
 *  1. Lisp-alphabet symbol tokens (kebab-case, `?`/`!`/`+`, `alias/name`)
 *     reach the named-seed injection instead of being filtered out.
 *  2. A bare token naming a NAMESPACE by its last segment resolves to the
 *     module and pulls its file into the render.
 *  3. An ambiguous bare token prefers the candidate co-located with the
 *     anchors (other tokens' locations) over a bigger-bodied def in an
 *     unrelated subsystem.
 *  4. A colon-less namespaced keyword (`app/set-page-state`) resolves to the
 *     re-frame registration node `:app/set-page-state` — without letting a
 *     bare name be hijacked by a same-named unqualified keyword.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function hasSqliteBindings(): boolean {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}
const HAS_SQLITE = hasSqliteBindings();

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-clj-'));
}

function rmTree(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A miniature monorepo with the shapes from the real-world failing session:
 * - app/page/lifecycle/{activate,set_state}.cljs — per-stage `dashboard` fns
 *   (the ambiguous name) plus namespace-named stages.
 * - app/page/hooks.cljs — a unique kebab fn (`on-route-change+`, the anchor)
 *   that dispatches the re-frame event.
 * - backend/scim.clj — an unrelated subsystem with a LONGER same-named
 *   `dashboard` fn (the co-location trap) .
 * - app/core/handlers.cljs — the re-frame registration `:app/set-page-state`.
 */
async function buildCljMonorepo(): Promise<string> {
  const root = tmpRoot();
  const w = (rel: string, content: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  w('frontend/src/app/page/hooks.cljs', `(ns app.page.hooks
  (:require [re-frame.core :as rf]))

(defn on-route-change+ [route]
  (rf/dispatch [:app/set-page-state {:route route}]))
`);
  w('frontend/src/app/page/lifecycle/activate.cljs', `(ns app.page.lifecycle.activate)

(defn dashboard [ctx]
  (assoc ctx :activated true))
`);
  w('frontend/src/app/page/lifecycle/set_state.cljs', `(ns app.page.lifecycle.set-state)

(defn dashboard [ctx]
  (assoc ctx :page-state :dashboard))
`);
  w('frontend/src/app/core/handlers.cljs', `(ns app.core.handlers
  (:require [re-frame.core :as rf]))

(rf/reg-event-fx :app/set-page-state
  (fn [{:keys [db]} [_ state]]
    {:db (assoc db :page-state state)}))

(rf/reg-sub :dashboard
  (fn [db _] (:dashboard db)))
`);
  w('backend/src/backend/scim.clj', `(ns backend.scim)

(defn dashboard [user opts audit log extra]
  (let [a (str user) b (str opts) c (str audit) d (str log) e (str extra)
        f (str a b) g (str c d) h (str e f) i (str g h)]
    (str a b c d e f g h i)))

(defn unrelated-one [] 1)
(defn unrelated-two [] 2)
(defn unrelated-three [] 3)
(defn unrelated-four [] 4)
`);
  // A 4th `dashboard` def so the name is ambiguous (>3 defs) and the
  // co-location pick actually runs — at <=3 defs ALL of them inject by design.
  w('backend/src/backend/admin.clj', `(ns backend.admin)

(defn dashboard [stats]
  (str "admin" stats))
`);
  return root;
}

describe.skipIf(!HAS_SQLITE)('explore — Clojure/monorepo query tokens', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;
  let findAllSymbols: (cg: any, s: string) => { nodes: any[]; note: string };

  beforeEach(async () => {
    projectRoot = await buildCljMonorepo();
    const CodeGraph = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = CodeGraph.initSync(projectRoot, {
      config: { include: ['**/*.clj', '**/*.cljs'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
    findAllSymbols = (handler as any).findAllSymbols.bind(handler);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  async function explore(query: string): Promise<string> {
    const res = await handler.execute('codegraph_explore', { query });
    return res.content.map((c: any) => c.text ?? '').join('\n');
  }

  it('kebab-case tokens reach seed injection (named file renders)', async () => {
    const out = await explore('on-route-change+ set-page-state route');
    expect(out).toContain('hooks.cljs');
    expect(out).toContain('on-route-change+');
  });

  it('a namespace-segment token pulls the module file into the render', async () => {
    // `set-state` is no function — only the ns app.page.lifecycle.set-state.
    const out = await explore('on-route-change+ set-state dashboard');
    expect(out).toContain('set_state.cljs');
  });

  it('an ambiguous bare token prefers the candidate co-located with anchors', async () => {
    // `dashboard` defs: two lifecycle stage fns (small) + backend.scim's
    // (largest body, wrong subsystem). The anchor `on-route-change+` lives in
    // frontend/src/app/page, so the lifecycle defs must win the render and
    // the SCIM file must not appear.
    const out = await explore('on-route-change+ activate set-state dashboard page lifecycle');
    expect(out).toContain('lifecycle/activate.cljs');
    expect(out).not.toContain('scim.clj');
  });

  it('a colon-less namespaced keyword resolves to the registration node', () => {
    const { nodes } = findAllSymbols(cg, 'app/set-page-state');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes[0].name).toBe(':app/set-page-state');
  });

  it('a bare name is NOT hijacked by a same-named unqualified keyword', () => {
    // `:dashboard` (reg-sub) exists AND fns named `dashboard` exist — the
    // colon fallback must not preempt plain-name resolution for bare tokens.
    const { nodes } = findAllSymbols(cg, 'dashboard');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.every((n: any) => n.name === 'dashboard')).toBe(true);
  });
});
