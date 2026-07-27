/**
 * Corpus-frequency discount on the exact-name bonus (#982 — the follow-up #746
 * floated but never landed).
 *
 * `nameMatchBonus` handed a flat 80 (whole query === name) / 60 (a token of a
 * multi-word query === name) regardless of how many symbols carry that name. A
 * generic non-stopword token that happens to be a symbol name — `usage`, `get`,
 * `status` — therefore collected the full bonus and outranked the product code
 * that actually answers the query but does not literally contain the token.
 *
 * The fixture is #982's layout — product code with NO symbol named `usage`,
 * plus peripheral helper scripts that each define a module-level `usage()` —
 * scaled so the token is genuinely corpus-common, which is the condition this
 * lever keys on. Measured on the fixture for `desktop status bar context window
 * usage` (69 nodes, 24 of them named `usage`):
 *
 *   before: every top slot is an `optional-skills/**` usage() at 71.3
 *   after:  the helpers leave the top 11 entirely; product code fills it
 *
 * Note what this lever does NOT do, because it is easy to over-claim: in #982's
 * 8-file minimal repro only TWO symbols are named `usage`, so the token is rare
 * and the IDF scale is ~0.8 — nearly inert, by design. Fixing that shape needs
 * the issue's complementary path lever (user-extensible de-prioritization),
 * which is deliberately out of scope here. Locked below by an explicit test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { nameMatchBonus, nameMatchIdfScale } from '../src/search/query-utils';

describe('nameMatchIdfScale', () => {
  it('leaves a unique name at full weight', () => {
    expect(nameMatchIdfScale(1, 10_000)).toBe(1);
  });

  it('decays monotonically as the name spreads across the corpus', () => {
    const total = 10_000;
    const scales = [1, 2, 10, 100, 1000].map((df) => nameMatchIdfScale(df, total));
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeLessThan(scales[i - 1]);
    }
  });

  it('discounts a very common name without erasing it', () => {
    const scale = nameMatchIdfScale(9_000, 10_000);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(0.5);
  });

  it('is degenerate-input safe', () => {
    expect(nameMatchIdfScale(0, 10_000)).toBe(1);
    expect(nameMatchIdfScale(5, 1)).toBe(1);
    expect(nameMatchIdfScale(NaN, 10_000)).toBe(1);
    // A name counted more often than the corpus size must not go negative.
    expect(nameMatchIdfScale(20_000, 10_000)).toBeGreaterThan(0);
  });
});

describe('nameMatchBonus corpus discount', () => {
  const corpus = (df: number, total = 10_000) => ({ total, countForName: () => df });

  it('is unchanged when no corpus stats are supplied', () => {
    expect(nameMatchBonus('usage', 'usage')).toBe(80);
    expect(nameMatchBonus('usage', 'context window usage')).toBe(60);
  });

  it('leaves a rare name at its original bonus', () => {
    expect(nameMatchBonus('usage', 'usage', corpus(1))).toBe(80);
    expect(nameMatchBonus('usage', 'context window usage', corpus(1))).toBe(60);
  });

  it('discounts a name shared by many symbols', () => {
    expect(nameMatchBonus('usage', 'context window usage', corpus(500))).toBeLessThan(60);
    expect(nameMatchBonus('usage', 'context window usage', corpus(500))).toBeGreaterThan(0);
  });

  it('does not touch prefix or substring bonuses', () => {
    // "Name starts with query" arm — small and already length-scaled.
    const withCorpus = nameMatchBonus('usageReporter', 'usage', corpus(5_000));
    const without = nameMatchBonus('usageReporter', 'usage');
    expect(withCorpus).toBe(without);
  });
});

describe('#982 — generic exact-name match crowding out product code', () => {
  const SKILLS = Array.from({ length: 24 }, (_, i) => `skill${i}`);
  let tmpDir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-982-'));
    const mk = (rel: string, content: string) => {
      const p = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    };

    // Product code answering "desktop status bar context window usage".
    // Note: no symbol here is literally named `usage`.
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

    // Peripheral helper scripts: each defines a module-level `usage`, and
    // nothing else about them answers the query. Enough of them that `usage`
    // is corpus-common (24 of 69 nodes) — the condition the discount keys on.
    for (const skill of SKILLS) {
      mk(
        `optional-skills/${skill}/scripts/${skill}_calc.ts`,
        [
          'export function usage(): void {',
          `  console.log("usage: ${skill}_calc [options]");`,
          '}',
        ].join('\n')
      );
    }

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
  }, 120_000);

  afterAll(() => {
    cg?.destroy();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const usageHelperRanks = (query: string): number[] => {
    const results = cg.searchNodes(query, { limit: 20 });
    const ranks: number[] = [];
    results.forEach((r, i) => {
      if (r.node.name.toLowerCase() === 'usage' && r.node.filePath.includes('optional-skills')) {
        ranks.push(i);
      }
    });
    return ranks;
  };

  it('keeps the generic usage() helpers out of the top ranks', () => {
    // Before the discount these occupied every top slot at an identical 71.3.
    const ranks = usageHelperRanks('desktop status bar context window usage');
    expect(ranks.slice(0, 2)).not.toEqual([0, 1]);
  });

  it('ranks at least one product symbol above the usage() helpers', () => {
    const results = cg.searchNodes('desktop status bar context window usage', { limit: 20 });
    const firstHelper = results.findIndex(
      (r) => r.node.name.toLowerCase() === 'usage' && r.node.filePath.includes('optional-skills')
    );
    const firstProduct = results.findIndex((r) => r.node.filePath.includes('apps/desktop'));
    expect(firstProduct).toBeGreaterThanOrEqual(0);
    if (firstHelper >= 0) {
      expect(firstProduct).toBeLessThan(firstHelper);
    }
  });

  it('still surfaces the helpers when the generic token IS the query', () => {
    // Discount, not erase: someone asking for `usage` must still find usage().
    const results = cg.searchNodes('usage', { limit: 20 });
    const helpers = results.filter(
      (r) => r.node.name.toLowerCase() === 'usage' && r.node.filePath.includes('optional-skills')
    );
    expect(helpers.length).toBeGreaterThan(0);
    expect(results.findIndex((r) => r.node.name.toLowerCase() === 'usage')).toBeLessThan(3);
  });
});

describe('#982 — the discount is corpus-frequency, not a blanket nerf', () => {
  it('barely moves a name that only a couple of symbols carry', () => {
    // #982's 8-file minimal repro has TWO usage() defs among ~25 nodes. The
    // token is rare there, so IDF is close to inert — this lever is not what
    // fixes that shape, and saying otherwise would overstate it.
    const scale = nameMatchIdfScale(2, 25);
    expect(scale).toBeGreaterThan(0.7);
    expect(nameMatchBonus('usage', 'context window usage', { total: 25, countForName: () => 2 }))
      .toBeGreaterThanOrEqual(45);
  });
});
