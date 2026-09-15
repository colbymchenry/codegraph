import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

let dir: string;
let cg: CodeGraph;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-requested-source-'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"requested-source-fixture"}');
  fs.writeFileSync(path.join(dir, 'snapshot.ts'), [
    ...Array.from({ length: 150 }, (_, i) => `export function helper${i}() { return ${i}; }`),
    'export function recommendedPickSnapshot(picks: unknown[]) {',
    '  return picks.map(player => ({ player, marker: "snapshot-body-end" }));',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'test', 'snapshot.test.ts'), [
    'import { recommendedPickSnapshot } from "../snapshot";',
    ...Array.from({ length: 35 }, (_, i) => [
      `it("unrelated sorting ${i}", () => {`,
      '  const rows = recommendedPickSnapshot([]);',
      ...Array.from({ length: 8 }, () => '  expect(rows).toEqual([]);'),
      '});',
    ].join('\n')),
    'it("recommendedPickSnapshot preserves recentPicks identity", () => {',
    '  const recentPicks = recommendedPickSnapshot([{ id: "4430871" }]);',
    '  expect(recentPicks).toMatchObject([',
    '    {',
    '      player: {',
    '        id: "4430871",',
    '      },',
    '      marker: "snapshot-body-end",',
    '    },',
    '  ]);',
    '  expect(recentPicks[0].player.id).toBe("4430871");',
    '});',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'LayoutBoard.vue'), [
    '<template>',
    '  <table>',
    '    <colgroup><col class="col-w-survival" /></colgroup>',
    ...Array.from({ length: 310 }, () => '    <tr><td class="spacer">filler</td></tr>'),
    '    <tr><td>{{ formatSurvival(player.survival) }}</td></tr>',
    '  </table>',
    '</template>',
    '<script setup lang="ts">',
    'const player = { survival: 0.9 };',
    'function formatSurvival(value: number) { return String(value); }',
    '</script>',
    '<style scoped>',
    '.col-w-survival {',
    '  width: 176px;',
    '  min-width: 176px;',
    '}',
    '</style>',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'models.ts'), [
    'export interface ConsensusPlayer {',
    ...Array.from({ length: 120 }, (_, i) => `  providerField${i}?: number | null;`),
    '  rawProviderEvidence: number | null;',
    '}',
    'export function calculateConsensusPlayer() {',
    ...Array.from({ length: 90 }, (_, i) => `  const decoy${i} = "${'incidental calculation '.repeat(8)}";`),
    '  return "incidental-name-infix";',
    '}',
    ...Array.from({ length: 250 }, (_, i) => `export function observe${i}() { return ${i}; }`),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'pipeline.ts'), [
    'const state = { isMockActive: false, draftedPlayerNames: [] as string[] };',
    'export const pipeline = {',
    ...Array.from({ length: 160 }, (_, i) => `  helper${i}() { return "${'padding '.repeat(20)}"; },`),
    '  consensusCalcKey() {',
    '    return [state.isMockActive, state.draftedPlayerNames.length].join("|");',
    '  },',
    '  evaluateConsensus() { return this.consensusCalcKey(); },',
    '};',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'receiver.ts'), [
    ...Array.from({ length: 100 }, (_, i) => `function filler${i}() { return "${'unrelated padding '.repeat(10)}"; }`),
    'function persistQueuePriority(value: number) {',
    ...Array.from({ length: 12 }, (_, i) => `  const check${i} = "${'validate the input '.repeat(4)}";`),
    '  return value;',
    '}',
    'function receiveQueueSnapshot(value: number) {',
    ...Array.from({ length: 12 }, (_, i) => `  const context${i} = "${'validate the context '.repeat(4)}";`),
    '  return persistQueuePriority(value);',
    '}',
    'export function listenForQueueMessage(value: number) {',
    ...Array.from({ length: 12 }, (_, i) => `  const channel${i} = "${'validate the sender '.repeat(4)}";`),
    '  return receiveQueueSnapshot(value);',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'identity.ts'), [
    'import { unrelatedHub } from "./hub";',
    'export function playerIdentity(id: number) { unrelatedHub(); return id; }',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'hub.ts'), [
    ...Array.from({ length: 30 }, (_, i) => `function hubStep${i}() { return ${i}; }`),
    `export function unrelatedHub() { ${Array.from({ length: 30 }, (_, i) => `hubStep${i}();`).join(' ')} }`,
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'receipt.ts'), [
    'import { playerIdentity } from "./identity";',
    'export function receipt0() { return playerIdentity(0); }',
    'export function receipt1() { return playerIdentity(1); }',
    'export function receipt2() { return playerIdentity(2); }',
  ].join('\n'));
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}, 60_000);

afterAll(() => {
  cg?.destroy();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function explore(query: string): Promise<string> {
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query });
  expect(result.isError).not.toBe(true);
  return result.content?.[0]?.text ?? '';
}

function sourceIn(text: string, file: string): string {
  const start = text.indexOf('**`' + file + '`**');
  expect(start, file).toBeGreaterThan(-1);
  const block = text.slice(start).match(/```[^\n]*\n([\s\S]*?)```/);
  expect(block, file).not.toBeNull();
  return block![1]!;
}

describe('requested evidence in large selected files', () => {
  it('prioritizes direct callers over a dense callee for a single named function', async () => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query: 'playerIdentity', maxFiles: 2 });
    const out = result.content?.[0]?.text ?? '';
    expect(sourceIn(out, 'identity.ts')).toContain('function playerIdentity');
    expect(sourceIn(out, 'receipt.ts')).toContain('return playerIdentity(0)');
  });
  it('keeps a compound-concept writer and its local receiver chain complete', async () => {
    const out = await explore('How does queue_priority reach storage?');
    const source = sourceIn(out, 'receiver.ts');
    expect(source).toContain('return value;');
    expect(source).toContain('return persistQueuePriority(value);');
    expect(source).toContain('return receiveQueueSnapshot(value);');
    expect(source).toContain('const context11 =');
    expect(source).toContain('const channel11 =');
    expect(out.length).toBeLessThanOrEqual(25_000);
  });
  it('returns the full named test when the query does not name its assertion', async () => {
    const out = await explore('test/snapshot.test.ts recommendedPickSnapshot');
    expect(sourceIn(out, 'test/snapshot.test.ts')).toContain('expect(recentPicks[0].player.id).toBe("4430871")');
  });

  it('retains bounded vocabulary seeds when other names rank above them', async () => {
    const graph = await cg.findRelevantContext('snapshot_helper storage', {
      searchLimit: 1, traversalDepth: 0, seedNames: ['helper149', 'recommendedPickSnapshot'],
    });
    expect(graph.roots.map(id => graph.nodes.get(id)?.name)).toEqual(
      expect.arrayContaining(['helper149', 'recommendedPickSnapshot']),
    );
  });
  it('keeps the declaration using the requested invalidation inputs', async () => {
    const out = await explore('evaluateConsensus in pipeline.ts: how do isMockActive and draftedPlayerNames invalidate cached players?');
    expect(sourceIn(out, 'pipeline.ts')).toContain('return [state.isMockActive, state.draftedPlayerNames.length].join("|")');
  });
  it('returns the complete identity assertion alongside the named implementation', async () => {
    const out = await explore('recommendedPickSnapshot in snapshot.ts: locate recentPicks identity assertions in test/snapshot.test.ts:');
    const test = sourceIn(out, 'test/snapshot.test.ts');
    expect(test).toContain('expect(recentPicks[0].player.id).toBe("4430871")');
    expect(test).toContain('marker: "snapshot-body-end"');
    expect(sourceIn(out, 'snapshot.ts')).toContain('return picks.map(player => ({ player, marker: "snapshot-body-end" }))');
  });

  it.each([
    'LayoutBoard.vue "col-w-survival"',
    'How does LayoutBoard format survival and set column widths?',
  ])('returns template and CSS evidence for %s', async query => {
    const out = await explore(query);
    const source = sourceIn(out, 'LayoutBoard.vue');
    expect(source).toContain('<colgroup><col class="col-w-survival" /></colgroup>');
    expect(source).toContain('.col-w-survival {');
    expect(source).toContain('min-width: 176px;');
    expect(out.length).toBeLessThanOrEqual(25_000);
  });

  it('returns a named interface body instead of unrelated declarations', async () => {
    const out = await explore('ConsensusPlayer fields in models.ts: locate raw provider evidence');
    const source = sourceIn(out, 'models.ts');
    expect(source).toContain('providerField0?: number | null;');
    expect(source).toContain('providerField60?: number | null;');
    expect(source).toContain('rawProviderEvidence: number | null;');
  });

  it('recognizes punctuation after a requested symbol', async () => {
    const out = await explore('recommendedPickSnapshot: preserve the returned snapshot');
    expect(sourceIn(out, 'snapshot.ts')).toContain('return picks.map(player => ({ player, marker: "snapshot-body-end" }))');
  });
});
