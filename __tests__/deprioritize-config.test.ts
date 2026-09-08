/**
 * `codegraph.json` → `deprioritize` — user-extensible ranking de-prioritization (#982).
 *
 * `matchesNonProductionDir` hardcodes example/sample/fixture/benchmark/demo, so a
 * peripheral tree only the project knows about — `optional-skills/`, `scripts/` —
 * gets no de-prioritization. When helpers in such a tree carry generic symbol
 * names, an exact name match hands them a large bonus and they crowd out the
 * product code that actually answers the query.
 *
 * This is the *ranking* half of #982, deliberately distinct from the corpus-
 * frequency discount: that one keys on a name being COMMON, and is near-inert on
 * #982's own 8-file repro where only two symbols are named `usage`. The fixture
 * here IS that repro, which is the point — the two levers cover different shapes.
 *
 * It is also distinct from `exclude`, which is a recall lever. De-prioritized
 * paths stay indexed and findable; they just stop winning. Locked below.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { loadDeprioritizePatterns } from '../src/project-config';
import { nameMatchBonus, scorePathRelevance } from '../src/search/query-utils';
import { DEPRIORITIZED_NAME_BONUS_SCALE } from '../src/db/queries';

const QUERY = 'desktop status bar context window usage';

/** #982's minimal reproduction layout. */
function writeRepro(root: string): void {
  const mk = (rel: string, content: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  // Product code. No symbol here is literally named `usage`.
  mk(
    'apps/desktop/statusbar/StatusBar.ts',
    [
      'export class DesktopStatusBar {',
      '  render(): string { return this.refresh(); }',
      '  refresh(): string { return "status bar"; }',
      '  mount(): void {}',
      '}',
    ].join('\n')
  );
  mk(
    'apps/desktop/statusbar/StatusBarController.ts',
    [
      "import { DesktopStatusBar } from './StatusBar';",
      'export class StatusBarController {',
      '  constructor(private readonly bar: DesktopStatusBar) {}',
      '  show(): string { return this.bar.render(); }',
      '}',
    ].join('\n')
  );
  mk(
    'apps/desktop/context/ContextWindowMeter.ts',
    [
      'export class ContextWindowMeter {',
      '  read(): number { return this.recompute(); }',
      '  recompute(): number { return estimateTokens("context window"); }',
      '}',
      'export function estimateTokens(text: string): number { return text.length; }',
    ].join('\n')
  );
  mk(
    'apps/desktop/context/format.ts',
    'export function formatTokens(n: number): string { return `${n} tokens`; }\n'
  );
  mk('gateway/server/server.ts', 'export function startServer(): void {}\n');
  mk('packages/core/util/strings.ts', 'export function slugify(s: string): string { return s; }\n');

  // The peripheral tree: two standalone helpers, each with a module-level `usage`.
  for (const skill of ['bodyfat', 'nutrition']) {
    mk(
      `optional-skills/${skill}/scripts/${skill}_calc.ts`,
      ['export function usage(): void {', `  console.log("usage: ${skill}_calc [options]");`, '}'].join('\n')
    );
  }
}

const isHelper = (r: { node: { name: string; filePath: string } }): boolean =>
  r.node.name.toLowerCase() === 'usage' && r.node.filePath.includes('optional-skills');

describe('codegraph.json deprioritize — parsing', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deprio-cfg-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (config: unknown): string => {
    const sub = fs.mkdtempSync(path.join(dir, 'p-'));
    fs.writeFileSync(path.join(sub, 'codegraph.json'), JSON.stringify(config));
    return sub;
  };

  it('defaults to empty with no config file', () => {
    const sub = fs.mkdtempSync(path.join(dir, 'none-'));
    expect(loadDeprioritizePatterns(sub)).toEqual([]);
  });

  it('keeps gitignore-style patterns verbatim, trimmed', () => {
    const sub = write({ deprioritize: ['optional-skills/', '  tools/gen  ', 'vendor/**'] });
    expect(loadDeprioritizePatterns(sub)).toEqual(['optional-skills/', 'tools/gen', 'vendor/**']);
  });

  it('warns-and-skips a non-array value instead of throwing', () => {
    const sub = write({ deprioritize: 'optional-skills/' });
    expect(loadDeprioritizePatterns(sub)).toEqual([]);
  });

  it('drops blank and non-string entries, keeping the rest', () => {
    const sub = write({ deprioritize: ['optional-skills/', '', 42, '   ', 'scripts/'] });
    expect(loadDeprioritizePatterns(sub)).toEqual(['optional-skills/', 'scripts/']);
  });

  it('does not disturb the other config keys', () => {
    const sub = write({ deprioritize: ['optional-skills/'], exclude: ['static/'] });
    expect(loadDeprioritizePatterns(sub)).toEqual(['optional-skills/']);
  });
});

describe('#982 minimal repro — ranking with and without deprioritize', () => {
  let baseDir: string;
  let cfgDir: string;
  let baseCg: CodeGraph;
  let cfgCg: CodeGraph;

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();

    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deprio-base-'));
    writeRepro(baseDir);
    baseCg = CodeGraph.initSync(baseDir);
    await baseCg.indexAll();

    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deprio-on-'));
    writeRepro(cfgDir);
    fs.writeFileSync(
      path.join(cfgDir, 'codegraph.json'),
      JSON.stringify({ deprioritize: ['optional-skills/'] }, null, 2)
    );
    cfgCg = CodeGraph.initSync(cfgDir);
    await cfgCg.indexAll();
  }, 180_000);

  afterAll(() => {
    baseCg?.destroy();
    cfgCg?.destroy();
    for (const d of [baseDir, cfgDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('control: without the config the usage() helpers still take the top ranks', () => {
    // This is the status quo the issue reports, and the shape the corpus-frequency
    // discount cannot fix (only two symbols are named `usage` here, so it is rare).
    const results = baseCg.searchNodes(QUERY, { limit: 20 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.slice(0, 2).every(isHelper)).toBe(true);
  });

  it('with deprioritize, product code outranks the peripheral helpers', () => {
    const results = cfgCg.searchNodes(QUERY, { limit: 20 });
    const firstHelper = results.findIndex(isHelper);
    const firstProduct = results.findIndex((r) => r.node.filePath.includes('apps/desktop'));
    expect(firstProduct).toBeGreaterThanOrEqual(0);
    expect(firstHelper === -1 || firstProduct < firstHelper).toBe(true);
  });

  it('is a ranking lever, not exclude: the helpers stay indexed and findable', () => {
    // The whole point of keeping this distinct from `exclude` — recall is intact.
    expect(cfgCg.getNodesByName('usage').length).toBe(2);
    const direct = cfgCg.searchNodes('usage', { limit: 20 });
    expect(direct.some(isHelper)).toBe(true);
  });

  it('leaves paths outside the patterns alone', () => {
    // gateway/ and packages/ are not named, so their scores must not move.
    const score = (cg: CodeGraph, file: string): number | undefined =>
      cg.searchNodes('slugify', { limit: 20 }).find((r) => r.node.filePath.includes(file))?.score;
    const baseline = score(baseCg, 'packages/core/util/strings.ts');
    expect(baseline).toBeDefined();
    expect(score(cfgCg, 'packages/core/util/strings.ts')).toBe(baseline);
  });

  it('a query that genuinely targets the tree still ranks it, competitor present', () => {
    // The "discount, don't erase" edge case #982 calls out. `bodyfat_calc` lives
    // only in the de-prioritized tree; a query naming it must still find it
    // first, even with product code competing for the same terms.
    const results = cfgCg.searchNodes('bodyfat calc usage', { limit: 20 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node.filePath).toContain('optional-skills/bodyfat');
  });

  it('explore ranking honours the setting, not just search', () => {
    // #982's reproduction rows B/C/D are all `codegraph explore`. Explore ranks
    // through its own path scorer as well as through searchNodes, so a
    // search-only fix would leave the reported surface unchanged.
    const matcher = (cfgCg as unknown as { queries: { getDeprioritizedPathMatcher(): ((p: string) => boolean) | undefined } })
      .queries.getDeprioritizedPathMatcher();
    expect(matcher).toBeDefined();
    expect(matcher!('optional-skills/bodyfat/scripts/bodyfat_calc.ts')).toBe(true);
    expect(matcher!('apps/desktop/statusbar/StatusBar.ts')).toBe(false);
  });

  it('picks up a config written after the project was opened', async () => {
    // wireLayers runs once per open, so a matcher captured there would freeze
    // at open time — and the MCP server keeps one CodeGraph per root alive for
    // its whole lifetime, which would make an edited config look like a no-op.
    const late = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deprio-late-'));
    writeRepro(late);
    const cg = CodeGraph.initSync(late);
    try {
      await cg.indexAll();
      const before = cg.searchNodes(QUERY, { limit: 20 });
      expect(before.length).toBeGreaterThanOrEqual(2);
      expect(before.slice(0, 2).every(isHelper)).toBe(true);

      fs.writeFileSync(
        path.join(late, 'codegraph.json'),
        JSON.stringify({ deprioritize: ['optional-skills/'] })
      );
      const after = cg.searchNodes(QUERY, { limit: 20 });
      const firstHelper = after.findIndex(isHelper);
      const firstProduct = after.findIndex((r) => r.node.filePath.includes('apps/desktop'));
      expect(firstProduct).toBeGreaterThanOrEqual(0);
      expect(firstHelper === -1 || firstProduct < firstHelper).toBe(true);
    } finally {
      cg.destroy();
      fs.rmSync(late, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('scorePathRelevance — the two deliberate asymmetries (#982)', () => {
  it('docks a path that is both test-like and de-prioritized only once', () => {
    const both = 'example/a/foo.ts';
    const asTestOnly = scorePathRelevance(both, 'foo');
    const asBoth = scorePathRelevance(both, 'foo', undefined, true);
    expect(asBoth).toBe(asTestOnly);
  });

  it('does not waive the user penalty for a test-y query, unlike the built-ins', () => {
    // The built-in classification is inferred, so a test-y query waives it. A
    // `deprioritize` pattern is a standing statement by the project, so it
    // stands. Asserted so the difference is a decision, not an accident.
    const builtIn = scorePathRelevance('example/a/foo.ts', 'foo test');
    const userDeclared = scorePathRelevance('optional-skills/a/foo.ts', 'foo test', undefined, true);
    expect(userDeclared).toBe(builtIn - 15);
  });
});

describe('the name-bonus damping constant is derived, not picked (#982)', () => {
  it('keeps a damped exact match above the prefix arm, so it cannot lose to one', () => {
    // A de-prioritized node keeps `80 * SCALE` of the whole-query exact bonus
    // and also takes the -15 path penalty. The prefix arm tops out below 40, so
    // `80 * SCALE - 15 > 40` is what guarantees the exact match still wins —
    // "discount, don't erase" stated as arithmetic instead of taste.
    expect(nameMatchBonus('child', 'child')).toBe(80);
    expect(nameMatchBonus('children', 'child')).toBeLessThan(40);
    expect(80 * DEPRIORITIZED_NAME_BONUS_SCALE - 15).toBeGreaterThan(40);
  });

  it('would fail at the originally proposed 0.25, which is why it moved', () => {
    // Measured on a 62k-node django index with `deprioritize: ["tests/"]`: at
    // 0.25 the exact-name queries `child`, `parent` and `method` lost rank 1 to
    // the prefix matches `children`, `all_parents` and `method_decorator`.
    // Asserted so nobody lowers the constant back without meeting the bound.
    expect(80 * 0.25 - 15).toBeLessThan(40);
  });
});
