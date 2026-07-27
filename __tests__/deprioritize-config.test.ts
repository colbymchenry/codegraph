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
    expect(score(cfgCg, 'packages/core/util/strings.ts')).toBe(
      score(baseCg, 'packages/core/util/strings.ts')
    );
  });
});
