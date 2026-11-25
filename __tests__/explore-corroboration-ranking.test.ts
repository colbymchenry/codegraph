/**
 * codegraph_explore — multi-term corroboration tier (cross-layer monorepo ranking).
 *
 * BEHAVIOURAL coverage for the `isCorroborated` tier in handleExplore's file sort:
 * a backend file that is BOTH an entry/central file AND matched by >=2 DISTINCT
 * query terms must be surfaced (rendered as a `#### <path>` source section) for a
 * backend-flow query in a multi-layer repo — not displaced by a denser frontend
 * layer. The tier exists because explore's primary file ranker is graph-centrality
 * (Random-Walk-with-Restart) mass, which — seeded from text matches that skew to
 * the bigger, internally dense layer — can bury a query-matching backend file under
 * an off-topic cluster. The entry/central GUARD keeps the tier safe: an INCIDENTAL
 * multi-term file that is neither entry nor central is NOT promoted, so it cannot
 * displace a graph-central answer file (the regression a blunt hits-only tier caused
 * on excalidraw, where `binding.ts`/`elbowArrow.ts` displaced `renderNewElementScene`).
 *
 * NOTE: the full directus-scale burial (where frontend RWR mass exceeds a
 * query-matching backend file) is an EMERGENT property of thousands of real frontend
 * symbols — a self-contained fixture can't reach the cluster size past
 * findRelevantContext's retrieval cap. That regression is isolated by the
 * deterministic ranking harness on real indexes (directus/n8n/excalidraw), where the
 * api/ service moves from "absent/mentioned" to "sourced" with no control regression.
 * These tests lock the user-visible behaviour the tier guarantees on a fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

/** Paths that explore rendered as full-body ``**`<path>`** —`` source sections.
 *  Headers are bold labels, not ATX headings (issue #778). */
function sourcedFiles(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\*\*`(.+?)`\*\* —/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

describe('codegraph_explore — multi-term corroboration tier', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-corrob-'));

    // --- The large, internally DENSE frontend layer ---------------------------
    // Many `app/` files whose SYMBOLS all match the word "item" and form a tight
    // call mesh, so Random-Walk-with-Restart mass (seeded from those text matches)
    // concentrates here. They are NOT the answer to a backend query — but at scale
    // their cluster mass out-ranks the call-isolated backend file.
    // "item" is a PATH token (app/item/...) so FTS (token-based, not substring)
    // retrieves every file for the query term "item" — matching directus's `app/`
    // tree where "item" is a real path/symbol token, not a camelCase fragment.
    const appItem = path.join(testDir, 'app', 'item');
    fs.mkdirSync(appItem, { recursive: true });
    const N = 30;
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      const prev = (i + N - 1) % N;
      // Each file imports two neighbours → a dense mesh of `references`/`calls`.
      // snake_case so FTS tokenizes "item" out of the symbol name (camelCase would
      // leave `itemview0` as a single unmatchable token).
      fs.writeFileSync(path.join(appItem, `view${i}.ts`),
        `import { item_view_${next} } from './view${next}';\n` +
        `import { item_view_${prev} } from './view${prev}';\n` +
        `export function item_view_${i}() {\n` +
        `  return item_view_${next}() + item_view_${prev}();\n` +
        `}\n`);
    }

    // --- The small, call-ISOLATED backend file (the answer) -------------------
    // Its PATH matches TWO distinct query terms (api/item/service.ts → item +
    // service), so it IS a search root (an entry file) with file-term-hits >=2 —
    // but its generic SYMBOLS don't text-match, and nothing in the frontend mesh
    // calls it, so it gets no RWR inflow and its restart mass is diluted across the
    // large frontend seed set. This is the directus shape: ItemsService is
    // search-relevant by name/path yet call-isolated from the frontend seed cluster,
    // so RWR alone buries it under the mesh. Only the corroboration tier (path/name
    // matches >=2 query terms AND it's an entry file) keeps it in.
    const apiItem = path.join(testDir, 'api', 'item');
    fs.mkdirSync(apiItem, { recursive: true });
    fs.writeFileSync(path.join(apiItem, 'service.ts'),
      `export class DataService {\n` +
      `  read() { return this.load(); }\n` +
      `  load(): string[] { return []; }\n` +
      `}\n`);

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('sources the corroborated backend file alongside a denser frontend cluster in a multi-layer repo', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'item service' });
    const text = res.content[0].text;
    const sourced = sourcedFiles(text);

    // The backend service — matched by item+service and a search root — must
    // be rendered, not truncated out by the frontend mesh's graph mass.
    expect(sourced).toContain('api/item/service.ts');
  });

  it('still leads with the backend file when the query names its symbol directly', async () => {
    // A query naming the backend symbol directly: the answer is the DataService
    // file; the frontend mesh stays subordinate (it matches only "item").
    const res = await handler.execute('codegraph_explore', { query: 'DataService read load' });
    const text = res.content[0].text;
    const sourced = sourcedFiles(text);
    expect(sourced).toContain('api/item/service.ts');
    // The named backend file leads — it is not displaced by the frontend layer.
    expect(sourced[0]).toBe('api/item/service.ts');
  });
});
