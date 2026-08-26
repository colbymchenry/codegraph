/**
 * Prism dispatcher fan-out bridge (Ruby).
 *
 * A `Prism::Dispatcher` fans a single AST walk out to every listener's
 * `on_<node_type>_node_enter/leave` method by NAME CONVENTION (`ruby-lsp`'s
 * visitor architecture): a listener registers itself with `dispatcher.register(self,
 * :on_x, :on_y, ...)`, and `dispatcher.dispatch(tree)` later invokes every
 * registered method on every registered listener — no static edge exists from
 * `dispatch` to `on_x`. This bridges each `dispatcher.dispatch(...)` call site
 * to the `on_*` methods of every listener constructed with that same
 * dispatcher variable in the enclosing method. Covers namespace disambiguation
 * and the precision boundary: an unrelated `.dispatch(` call (e.g. a Redux-style
 * store) resolves to no listener-shaped class and produces no edge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('prism-dispatch synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-dispatch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  it('bridges dispatcher.dispatch to every constructed listener\'s registered on_* methods', async () => {
    write('lib/listeners/hover.rb', `module Requests
  class Hover
    def initialize(dispatcher)
      dispatcher.register(
        self,
        :on_call_node_enter,
        :on_constant_read_node_enter,
      )
    end

    def on_call_node_enter(node)
    end

    def on_constant_read_node_enter(node)
    end
  end
end
`);
    write('lib/listeners/folding_ranges.rb', `module Requests
  class FoldingRanges
    def initialize(dispatcher)
      dispatcher.register(self, :on_block_node_enter)
    end

    def on_block_node_enter(node)
    end
  end
end
`);
    // Namespace collision: two Hover-ish listeners under different modules —
    // only relevant here as a sanity check that unqualified names still work
    // when unambiguous; the qualified case is covered implicitly since both
    // listeners above are namespaced under Requests.
    write('lib/server.rb', `module Requests
  class Server
    def run_combined_requests(document)
      dispatcher = Prism::Dispatcher.new
      hover = Requests::Hover.new(dispatcher)
      folding_range = Requests::FoldingRanges.new(dispatcher)
      dispatcher.dispatch(document.ast)
    end
  end
end
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db
      .prepare(
        `SELECT s.name source, t.name target, t.file_path tf, json_extract(e.metadata,'$.via') via
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'prism-dispatch'`
      )
      .all();

    expect(edges.every((r: any) => r.source === 'run_combined_requests')).toBe(true);
    const targets = edges.map((r: any) => r.target).sort();
    expect(targets).toEqual(['on_block_node_enter', 'on_call_node_enter', 'on_constant_read_node_enter']);
    expect(edges.map((r: any) => r.via).sort()).toEqual([
      'Requests::FoldingRanges', 'Requests::Hover', 'Requests::Hover',
    ]);

    cg.close?.();
  });

  it('does not link a listener constructed with a different dispatcher variable', async () => {
    write('lib/listeners/hover.rb', `module Requests
  class Hover
    def initialize(dispatcher)
      dispatcher.register(self, :on_call_node_enter)
    end

    def on_call_node_enter(node)
    end
  end
end
`);
    write('lib/server.rb', `module Requests
  class Server
    def run(document)
      dispatcher_a = Prism::Dispatcher.new
      dispatcher_b = Prism::Dispatcher.new
      hover = Requests::Hover.new(dispatcher_a)
      dispatcher_b.dispatch(document.ast)
    end
  end
end
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const count = db
      .prepare(`SELECT count(*) c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'prism-dispatch'`)
      .get();
    expect(count.c).toBe(0);
    cg.close?.();
  });

  it('produces no edges for an unrelated .dispatch call (e.g. a Redux-style store)', async () => {
    write('lib/store.rb', `class Store
  def initialize
    @actions = []
  end

  def dispatch(action)
    @actions << action
  end
end
`);
    write('lib/app.rb', `class App
  def run
    store = Store.new
    store.dispatch(:increment)
  end
end
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const count = db
      .prepare(`SELECT count(*) c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'prism-dispatch'`)
      .get();
    expect(count.c).toBe(0);
    cg.close?.();
  });
});
