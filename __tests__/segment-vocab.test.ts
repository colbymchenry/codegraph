import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { extractProseCandidates } from '../src/search/identifier-segments';

/**
 * The graph-derived gate behind the prompt hook's MEDIUM tier: symbol names
 * are segmented into the words a human uses for them in prose
 * (name_segment_vocab, populated on the node write path), and
 * CodeGraph.getSegmentMatches verifies prompt words against them with
 * co-occurrence / rarity rules. Precision comes from the repo's own naming
 * statistics — no keyword vocabulary involved.
 */
describe('name-segment vocabulary + getSegmentMatches (graph-derived gate)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segment-vocab-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'state-machine.ts'),
      `export class OrderStateMachine {
  transition(from: string, to: string): boolean { return from !== to; }
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'checkout.ts'),
      `export class CheckoutService {
  submitOrder(): void {}
}
export class CheckoutController {
  handle(): void {}
}
export function loadConfig(): void {}
`,
    );
    // 30 distinct names sharing the segment "data" — a ubiquitous segment that
    // must NOT qualify as a single-word signal (rarity ceiling).
    const noise = Array.from({ length: 30 }, (_, i) => {
      const suffix = `${String.fromCharCode(65 + (i % 26))}${i}`;
      return `export function dataLoader${suffix}(): number { return ${i}; }`;
    }).join('\n');
    // The measured-FP shapes: a repo-rare segment that is an English function
    // word ("this"), and a common-verb segment ("write").
    const fpBait = `
export function resolveDeferredThisMemberRefs(): void {}
export function writeConfig(): void {}
`;
    fs.writeFileSync(path.join(dir, 'src', 'noise.ts'), noise + fpBait + '\n');

    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('co-occurrence: two prose words on one name find it — the reported-prompt shape', () => {
    // The words a French prompt would produce: "comment marche la state
    // machine des commandes ?" — no keyword list knows any of them.
    const words = extractProseCandidates('comment marche la state machine des commandes ?');
    const matches = cg.getSegmentMatches(words);
    expect(matches.map((m) => m.name)).toContain('OrderStateMachine');
    const hit = matches.find((m) => m.name === 'OrderStateMachine')!;
    expect(hit.matchedWords).toEqual(['machine', 'state']);
    expect(hit.filePath).toContain('state-machine.ts');
    expect(hit.kind).not.toBe('file');
  });

  it('single rare word qualifies; ubiquitous and singleton words do not', () => {
    // "checkout" clusters (Service + Controller) — a concept this repo is about.
    expect(cg.getSegmentMatches(['checkout']).map((m) => m.name)).toContain('CheckoutService');
    // "data" appears in 30 names here — noise, not signal.
    expect(cg.getSegmentMatches(['data'])).toEqual([]);
    // "machine" appears in exactly ONE name — a singleton is prose
    // coincidence for a single word (the "deploy to production" FP shape);
    // it stays reachable through co-occurrence ("state machine").
    expect(cg.getSegmentMatches(['machine'])).toEqual([]);
  });

  it('plural folding: "services" still meets the "service" segment', () => {
    const matches = cg.getSegmentMatches(['checkout', 'services']);
    const hit = matches.find((m) => m.name === 'CheckoutService');
    expect(hit).toBeDefined();
    expect(hit!.matchedWords).toEqual(['checkout', 'services']);
  });

  it('vocab rows are proposals — a name with no surviving node is never surfaced', () => {
    // Plant an orphan row (as file deletion would): the honesty gate must drop it.
    const queries = (cg as unknown as { queries: { insertNameSegmentsBatch(names: string[]): void } }).queries;
    queries.insertNameSegmentsBatch(['GhostSymbolMachine']);
    const matches = cg.getSegmentMatches(['ghost', 'symbol']);
    expect(matches).toEqual([]);
  });

  it('unrelated prose matches nothing', () => {
    expect(cg.getSegmentMatches(extractProseCandidates('write a haiku about autumn leaves'))).toEqual([]);
  });

  it('English function/filler words are never single-word evidence — the measured FPs', () => {
    // "fix this typo" — 'this' IS a (rare!) segment here via
    // resolveDeferredThisMemberRefs; the stoplist keeps it out of candidates.
    expect(cg.getSegmentMatches(extractProseCandidates('fix this typo'))).toEqual([]);
    // "write …" — writeConfig exists; 'write' is stoplisted prose.
    expect(cg.getSegmentMatches(extractProseCandidates('write something for the readme'))).toEqual([]);
    // Engine-level backstop, independent of extraction: a sub-5-char single
    // word never fires the single-word tier even if a caller passes it raw.
    expect(cg.getSegmentMatches(['this'])).toEqual([]);
    // But the same segments remain reachable through CO-OCCURRENCE — the
    // stoplist only removes thin single-word evidence: naming both halves of
    // writeConfig via prose is still a match ("config" is not stoplisted).
    expect(cg.getSegmentMatches(['config']).map((m) => m.name)).toContain('writeConfig');
  });

  it('sync heals an empty vocab over a populated graph (pre-vocab-table upgrade path)', async () => {
    const queries = (cg as unknown as { queries: { clearNameSegmentVocab(): void; isNameSegmentVocabEmpty(): boolean } }).queries;
    queries.clearNameSegmentVocab();
    expect(queries.isNameSegmentVocabEmpty()).toBe(true);
    await cg.sync();
    expect(queries.isNameSegmentVocabEmpty()).toBe(false);
    expect(cg.getSegmentMatches(['state', 'machine']).map((m) => m.name)).toContain('OrderStateMachine');
  });

  it('heal covers UNCHANGED files even when the same sync also indexes changed ones', async () => {
    // Regression: emptiness must be captured at sync ENTRY — the sync's own
    // incremental writes populate rows for the files it touches, and an
    // end-of-sync emptiness check would see those rows and skip the backfill,
    // leaving every unchanged file's names unsegmented forever.
    const queries = (cg as unknown as { queries: { clearNameSegmentVocab(): void } }).queries;
    queries.clearNameSegmentVocab();
    const touched = path.join(dir, 'src', 'state-machine.ts');
    fs.writeFileSync(touched, fs.readFileSync(touched, 'utf8') + '\n// touched\n');
    await cg.sync();
    // The touched file's names came from the incremental write path; the
    // UNTOUCHED file's names must come from the backfill.
    expect(cg.getSegmentMatches(['checkout']).map((m) => m.name)).toContain('CheckoutService');
  });
});
