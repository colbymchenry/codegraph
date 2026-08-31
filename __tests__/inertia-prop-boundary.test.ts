/**
 * The Inertia prop boundary, end to end.
 *
 * The contract is the prop map, written twice and referenced by neither half.
 * These tests pin the three things that make linking it useful rather than
 * merely plausible:
 *
 *   1. the two halves may not share a spelling (a camelizing server emits
 *      `user_display_name` for a client reading `userDisplayName`);
 *   2. "used" is a per-SYMBOL question — a `type`/`interface` that DECLARES a
 *      field is not a consumer of it, and a module that holds both declarations
 *      and runtime helpers has to be able to be both at once;
 *   3. a data-keyed map is a dynamic edge, not a prop schema, and must produce
 *      no links at all.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { propKeysFromMap, clientCandidates, inertiaResolver } from '../src/resolution/frameworks/inertia';
import { findPageFile } from '../src/resolution/inertia-prop-synthesizer';

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

describe('propKeysFromMap — only literal, only top level', () => {
  it('reads Elixir atom keys', () => {
    expect(propKeysFromMap('%{user_display_name: 1, year_2024: 2}').map((p) => p.key))
      .toEqual(['user_display_name', 'year_2024']);
  });

  it('reads PHP array keys', () => {
    expect(propKeysFromMap("['user_name' => $u, 'is_admin' => false]").map((p) => p.key))
      .toEqual(['user_name', 'is_admin']);
  });

  it('reads Ruby symbol keys in both spellings', () => {
    expect(propKeysFromMap('{ user_name: u, :is_admin => false }').map((p) => p.key))
      .toEqual(['user_name', 'is_admin']);
  });

  it('flags a preserve_case key', () => {
    const keys = propKeysFromMap('%{preserve_case(:HTTP_status) => v, normal_key: 1}');
    expect(keys.find((k) => k.key === 'HTTP_status')?.preserved).toBe(true);
    expect(keys.find((k) => k.key === 'normal_key')?.preserved).toBe(false);
  });

  it('ignores keys nested inside another map', () => {
    // An adapter camelizes EVERY key at every depth with no distinction
    // between a schema key and a DATA key, so a map keyed by a user-supplied
    // name is transformed exactly like a field name. Treating those as props
    // would invent names and produce confident wrong links.
    const keys = propKeysFromMap('%{by_region: %{north_east: 1, south_west: 2}, total: 3}').map((k) => k.key);
    expect(keys).toEqual(expect.arrayContaining(['by_region', 'total']));
    expect(keys).not.toContain('north_east');
    expect(keys).not.toContain('south_west');
  });
});

describe('clientCandidates — both spellings, because the setting is not assumed', () => {
  it('offers the verbatim and camelized forms', () => {
    expect(clientCandidates('user_display_name', false)).toEqual([
      'user_display_name', 'userDisplayName',
    ]);
  });

  it('offers only the verbatim form for a preserved key', () => {
    expect(clientCandidates('HTTP_status', true)).toEqual(['HTTP_status']);
  });

  it('collapses to one candidate when the transform is a no-op', () => {
    expect(clientCandidates('total', false)).toEqual(['total']);
  });
});

describe('findPageFile — Inertia page-name convention', () => {
  const files = [
    'assets/inertia/pages/Reports/Index.tsx',
    'assets/inertia/pages/Dashboard.tsx',
    'assets/inertia/lib/Dashboard.tsx',
    'app/components/Reports/Index.tsx',
  ];

  it('resolves a nested page name against any pages root', () => {
    expect(findPageFile('Reports/Index', files)).toBe('assets/inertia/pages/Reports/Index.tsx');
  });

  it('requires a pages/ segment, so a same-named module is not mistaken for it', () => {
    expect(findPageFile('Dashboard', files)).toBe('assets/inertia/pages/Dashboard.tsx');
  });

  it('returns null for a page with no component', () => {
    expect(findPageFile('Missing/Page', files)).toBeNull();
  });
});

describe('inertia resolver — extraction from each adapter', () => {
  const extract = (file: string, content: string) =>
    inertiaResolver.extract!(file, content).nodes;

  it('extracts props from a Phoenix render_inertia call', () => {
    const nodes = extract('lib/app_web/controllers/report_controller.ex',
      'def index(conn, _p) do\n  render_inertia(conn, "Reports/Index", %{user_display_name: w, total: t})\nend\n');
    expect(nodes.map((n) => n.name)).toEqual(['user_display_name', 'total']);
    expect(nodes[0]!.decorators).toContain('page=Reports/Index');
    // Both halves of the contract are visible on the node itself.
    expect(nodes[0]!.signature).toBe('user_display_name → user_display_name | userDisplayName');
  });

  it('extracts props from a Laravel Inertia::render call', () => {
    const nodes = extract('app/Http/Controllers/ReportController.php',
      "<?php\nclass C { public function index() { return Inertia::render('Reports/Index', ['user_name' => $u]); } }\n");
    expect(nodes.map((n) => n.name)).toEqual(['user_name']);
    expect(nodes[0]!.decorators).toContain('page=Reports/Index');
  });

  it('extracts props from a Rails render inertia: call', () => {
    const nodes = extract('app/controllers/reports_controller.rb',
      "class ReportsController\n  def index\n    render inertia: 'Reports/Index', props: { user_name: @u }\n  end\nend\n");
    expect(nodes.map((n) => n.name)).toEqual(['user_name']);
  });

  it('ignores a file with no render call', () => {
    expect(extract('app/models/user.rb', 'class User\nend\n')).toEqual([]);
  });

  it('extracts props from the piped Phoenix form, where conn is not an argument', () => {
    // Idiomatic Elixir pipes the conn in, so the render call carries only the
    // page and the props. A pattern that requires a positional conn matches
    // none of these — which is most of them in a real Phoenix codebase.
    const nodes = extract('lib/app_web/controllers/page_controller.ex',
      'conn\n|> put_status(404)\n|> Inertia.Controller.render_inertia("Errors/NotFound", %{requested_path: p, suggestion: s})\n');
    expect(nodes.map((n) => n.name)).toEqual(['requested_path', 'suggestion']);
    expect(nodes[0]!.decorators).toContain('page=Errors/NotFound');
  });

  it('ignores a computed page name — it names no component we could find', () => {
    expect(extract('lib/x.ex', 'render_inertia(conn, page_name, %{a: 1})')).toEqual([]);
    // The piped form of the same thing is equally unusable.
    expect(extract('lib/x.ex', 'conn |> render_inertia(page_name, %{a: 1})')).toEqual([]);
  });
});

describe('inertia resolver — detection', () => {
  // Inertia is a server+client framework, so the app that uses it is often not
  // the root of the repo it lives in. Reading only root manifests means the
  // resolver silently never activates on that layout, and a silent
  // non-activation is indistinguishable from a project that has no Inertia.
  const contextWith = (files: Record<string, string>): any => ({
    readFile: (p: string) => files[p] ?? null,
    getAllFiles: () => Object.keys(files),
  });

  it('detects an adapter declared in a root manifest', () => {
    expect(inertiaResolver.detect!(contextWith({
      'mix.exs': 'defp deps do [{:inertia, "~> 2.0"}] end',
    }))).toBe(true);
  });

  it('detects an adapter declared in a nested app manifest', () => {
    expect(inertiaResolver.detect!(contextWith({
      'package.json': '{"devDependencies":{"prettier":"^3"}}',
      'app/mix.exs': 'defp deps do [{:inertia, "~> 2.0"}] end',
      'app/lib/app_web/router.ex': 'defmodule R do end',
    }))).toBe(true);
  });

  it('detects a client-only adapter under a workspace', () => {
    expect(inertiaResolver.detect!(contextWith({
      'app/assets/package.json': '{"dependencies":{"@inertiajs/react":"^2"}}',
    }))).toBe(true);
  });

  it('stays off for a project with manifests but no Inertia', () => {
    expect(inertiaResolver.detect!(contextWith({
      'package.json': '{"dependencies":{"react":"^19"}}',
      'app/mix.exs': 'defp deps do [{:phoenix, "~> 1.7"}] end',
      'app/composer.json': '{"require":{"laravel/framework":"^11"}}',
    }))).toBe(false);
  });

  it('does not read every file in the repo looking for one', () => {
    // The scan is over manifests by name, not content — a large repo must not
    // pay a whole-index read for a framework it does not use.
    const read: string[] = [];
    const files: Record<string, string> = {};
    for (let i = 0; i < 500; i++) files[`src/mod_${i}.ts`] = 'export const x = 1;';
    files['app/mix.exs'] = 'defp deps do [{:phoenix, "~> 1.7"}] end';
    inertiaResolver.detect!({
      readFile: (p: string) => { read.push(p); return files[p] ?? null; },
      getAllFiles: () => Object.keys(files),
    } as any);
    expect(read.filter((p) => p.endsWith('.ts'))).toEqual([]);
  });
});

describe.skipIf(!HAS_SQLITE)('prop → consumer edges', () => {
  let root: string;
  let cg: any;
  let edges: Array<Record<string, any>>;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-inertia-'));
    const write = (rel: string, body: string) => {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    };

    write('package.json', JSON.stringify({ dependencies: { '@inertiajs/react': '^1.0.0' } }));
    // Rails server half — available without any extra language support.
    write('app/controllers/reports_controller.rb', `class ReportsController
  def index
    render inertia: 'Reports/Index', props: {
      user_display_name: @w,
      never_drawn: @n,
      total: @t
    }
  end
end
`);
    // The page component. `userDisplayName` is read by the component (a
    // consumer); `neverDrawn` appears ONLY in the type declaration, which must
    // not count; `total` is read by a helper function.
    write('assets/pages/Reports/Index.tsx', `import { formatTotal } from '../../lib/report-types';

interface Props {
  userDisplayName: number;
  neverDrawn: string;
  total: number;
}

export default function Index({ userDisplayName, total }: Props) {
  return userDisplayName + formatTotal(total);
}
`);
    // The module that is BOTH: declarations that must not count as consumers,
    // and a runtime helper that must.
    write('assets/lib/report-types.ts', `export interface ReportPayload {
  userDisplayName: number;
  neverDrawn: string;
}

export function formatTotal(total: number): string {
  return String(total);
}
`);

    const CodeGraph = (await import('../src/index')).default;
    cg = CodeGraph.initSync(root, {
      config: { include: ['**/*.rb', '**/*.ts', '**/*.tsx', 'package.json'], exclude: [] },
    });
    await cg.indexAll();
    edges = (cg as any).db.db
      .prepare(
        `SELECT s.name src, s.kind skind, s.file_path sfile,
                t.name prop, t.qualified_name propq,
                json_extract(e.metadata,'$.clientKey') clientKey,
                json_extract(e.metadata,'$.page') page
           FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
          WHERE json_extract(e.metadata,'$.synthesizedBy') = 'inertia-prop'`
      )
      .all();
  }, 120000);

  afterEach(() => {
    cg?.destroy();
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a node per emitted prop, named as the server wrote it', () => {
    const props = (cg as any).db.db
      .prepare(`SELECT name, qualified_name q FROM nodes WHERE kind='property' ORDER BY name`)
      .all();
    expect(props.map((p: any) => p.name)).toEqual(['never_drawn', 'total', 'user_display_name']);
    expect(props.find((p: any) => p.name === 'total').q).toBe('Reports/Index.total');
  });

  it('links a prop across the camelize boundary, where a grep finds only one side', () => {
    const forProp = edges.filter((e) => e.prop === 'user_display_name');
    expect(forProp.length).toBeGreaterThan(0);
    // The server never writes `userDisplayName` and the client never writes
    // `user_display_name`; this edge is the only thing joining them.
    expect(forProp[0]!.clientKey).toBe('userDisplayName');
    expect(forProp.map((e) => e.src)).toContain('Index');
  });

  it('does NOT count a type declaration as a consumer', () => {
    // `neverDrawn` appears in TWO interfaces and nowhere else. If a declaration
    // counted, this prop would look used and the dead-prop finding would be
    // invisible — the failure that hides the feature's whole point.
    const forProp = edges.filter((e) => e.prop === 'never_drawn');
    expect(forProp).toEqual([]);
  });

  it('leaves a genuinely dead prop with no consumers, so it is findable', () => {
    const consumed = new Set(edges.map((e) => e.prop));
    expect(consumed.has('user_display_name')).toBe(true);
    expect(consumed.has('total')).toBe(true);
    expect(consumed.has('never_drawn')).toBe(false);
  });

  it('treats one module as BOTH declaration and consumer', () => {
    // report-types.ts exports interfaces (not consumers) AND `formatTotal` (a
    // consumer). Any rule that has to classify the FILE gets this wrong in one
    // direction; both directions are silent.
    const fromTypes = edges.filter((e) => e.sfile.endsWith('lib/report-types.ts'));
    for (const e of fromTypes) expect(e.skind).not.toBe('interface');
    // And the interfaces there contributed nothing.
    expect(fromTypes.every((e) => e.skind !== 'type_alias')).toBe(true);
  });

  it('attributes each consumer to the symbol that reads it, not the file', () => {
    for (const e of edges) {
      expect(['function', 'method', 'variable', 'constant', 'component', 'property', 'field'])
        .toContain(e.skind);
    }
  });

  it('answers "is this prop read anywhere" through the graph', () => {
    const dead = (cg as any).db.db
      .prepare(
        `SELECT n.name FROM nodes n
          WHERE n.kind = 'property'
            AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target = n.id)`
      )
      .all();
    expect(dead.map((d: any) => d.name)).toEqual(['never_drawn']);
  });
});
