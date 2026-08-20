import { describe, it, expect } from 'vitest';
import {
  splitIdentifierSegments,
  extractProseCandidates,
  normalizeProseWord,
  segmentLookupVariants,
} from '../src/search/identifier-segments';

describe('splitIdentifierSegments — symbol names → prose words', () => {
  it('splits camelCase / PascalCase at humps', () => {
    expect(splitIdentifierSegments('OrderStateMachine')).toEqual(['order', 'state', 'machine']);
    expect(splitIdentifierSegments('userId')).toEqual(['user', 'id']);
  });

  it('handles acronym runs — HTML stays one segment', () => {
    expect(splitIdentifierSegments('parseHTMLDocument')).toEqual(['parse', 'html', 'document']);
    expect(splitIdentifierSegments('HTMLParser')).toEqual(['html', 'parser']);
  });

  it('keeps digits glued to their word', () => {
    expect(splitIdentifierSegments('base64Encode')).toEqual(['base64', 'encode']);
    expect(splitIdentifierSegments('parseHTML5Doc')).toEqual(['parse', 'html5', 'doc']);
  });

  it('splits snake_case, kebab-case, and dotted file names', () => {
    expect(splitIdentifierSegments('snake_case_name')).toEqual(['snake', 'case', 'name']);
    expect(splitIdentifierSegments('MAX_RETRY_COUNT')).toEqual(['max', 'retry', 'count']);
    expect(splitIdentifierSegments('checkout.service.ts')).toEqual(['checkout', 'service', 'ts']);
    expect(splitIdentifierSegments('state-machine')).toEqual(['state', 'machine']);
  });

  it('drops sub-minimum and digit-only fragments, dedupes', () => {
    expect(splitIdentifierSegments('x')).toEqual([]);
    expect(splitIdentifierSegments('42')).toEqual([]);
    expect(splitIdentifierSegments('getData_getData')).toEqual(['get', 'data']);
  });
});

describe('extractProseCandidates — prompt prose → lookup words', () => {
  it('keeps content words, drops short function words, in any Latin language', () => {
    expect(extractProseCandidates('comment marche la state machine des commandes ?')).toEqual([
      'comment', 'marche', 'state', 'machine', 'commandes',
    ]);
  });

  it('strips diacritics so loanwords meet ASCII identifier segments', () => {
    expect(extractProseCandidates('la résolution des références')).toEqual(['resolution', 'references']);
    expect(normalizeProseWord('Übersicht')).toBe('ubersicht');
  });

  it("splits on apostrophes — l'architecture keeps the noun", () => {
    expect(extractProseCandidates("explique l'architecture du module de stock")).toEqual([
      'explique', 'architecture', 'module', 'stock',
    ]);
  });

  it('caps candidates and skips unsegmented-script sentence runs', () => {
    const many = Array.from({ length: 25 }, (_, i) => `distinctword${String.fromCharCode(97 + i)}`).join(' ');
    expect(extractProseCandidates(many)).toHaveLength(16);
    // A no-spaces CJK sentence is one giant run — over the length ceiling, skipped.
    expect(extractProseCandidates('請解釋一下這個訂單狀態機的整體運作流程與架構設計方式')).toEqual([]);
    // Short CJK runs pass through as candidates — no script filter; the graph
    // verification tier rejects them (identifiers are almost never CJK).
    expect(extractProseCandidates('修复这个拼写错误')).toEqual(['修复这个拼写错误']);
  });

  it('drops digit-only and sub-4-char words', () => {
    expect(extractProseCandidates('fix the bug in v2 at 1234')).toEqual([]);
  });
});

describe('segmentLookupVariants — light plural folding', () => {
  it('folds trailing s/es so plurals hit singular segments', () => {
    expect(segmentLookupVariants('services')).toContain('service');
    expect(segmentLookupVariants('machines')).toContain('machine');
    expect(segmentLookupVariants('classes')).toContain('class');
  });

  it('bare-s plurals no longer mint a bogus -es sibling (#1145)', () => {
    expect(segmentLookupVariants('services')).toEqual(['services', 'service']);
    expect(segmentLookupVariants('machines')).toEqual(['machines', 'machine']);
  });

  it('unambiguous sibilant-es plurals no longer mint a bogus -s sibling (#1145)', () => {
    expect(segmentLookupVariants('classes')).toEqual(['classes', 'class']);
    expect(segmentLookupVariants('hashes')).toEqual(['hashes', 'hash']);
  });

  it('a trailing -ss is a singular, not a plural — no strip (#1145)', () => {
    expect(segmentLookupVariants('class')).toEqual(['class']);
    expect(segmentLookupVariants('process')).toEqual(['process']);
  });

  it('ambiguous endings emit BOTH candidate keys — a wrong exclusive guess would lose the real match', () => {
    expect(segmentLookupVariants('caches')).toEqual(['caches', 'cach', 'cache']);       // cache + s
    expect(segmentLookupVariants('databases')).toEqual(['databases', 'databas', 'database']); // database + s
  });

  it('never strips a word below the minimum', () => {
    expect(segmentLookupVariants('bus')).toEqual(['bus']);
    expect(segmentLookupVariants('boxes')).toEqual(['boxes']); // -es strip would go sub-minimum
  });
});
