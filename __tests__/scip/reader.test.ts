import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { decodeScipIndex, loadScipIndex, parseSymbol, ROLE_DEFINITION } from '../../src/scip/reader';
import { looksLikeCall } from '../../src/scip/syntax';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scip-ts');

// --- a tiny protobuf encoder, just enough to build typed-range occurrences ---
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const field = (num: number, wire: number) => varint(num * 8 + wire);
const len = (num: number, bytes: number[]) => [...field(num, 2), ...varint(bytes.length), ...bytes];
const str = (num: number, s: string) => len(num, [...Buffer.from(s, 'utf8')]);
const int = (num: number, v: number) => [...field(num, 0), ...varint(v)];

describe('SCIP reader', () => {
  it('decodes a real scip-typescript index', () => {
    const ix = loadScipIndex(path.join(FIXTURE, 'index.scip'));
    expect(ix.toolName).toBe('scip-typescript');
    expect(ix.documents.map(d => d.relativePath).sort()).toEqual(['src/main.ts', 'src/models.ts']);
    const main = ix.documents.find(d => d.relativePath === 'src/main.ts')!;
    const sumDef = main.occurrences.find(o => o.roles & ROLE_DEFINITION && o.symbol.endsWith('/sum().'))!;
    expect(sumDef.range).toEqual({ startLine: 2, startCol: 16, endLine: 2, endCol: 19 });
  });

  it('prefers typed ranges over the deprecated int32 ones, and skips fields it does not use', () => {
    const occ = [
      ...len(1, [...varint(9), ...varint(9), ...varint(9)]), // legacy range, packed
      ...str(2, 'scip-typescript npm p 1.0.0 src/`a.ts`/f().'),
      ...len(9, [...int(1, 4), ...int(2, 2), ...int(3, 6), ...int(4, 1)]), // MultiLineRange
      ...len(11, [...int(1, 3), ...int(2, 0), ...int(3, 7), ...int(4, 1)]), // enclosing range: unused
    ];
    const doc = [...str(1, 'src/a.ts'), ...len(2, occ), ...str(4, 'TypeScript')];
    const ix = decodeScipIndex(Buffer.from([...len(2, doc)]));
    expect(ix.documents[0]!.occurrences).toEqual([{
      range: { startLine: 4, startCol: 2, endLine: 6, endCol: 1 },
      symbol: 'scip-typescript npm p 1.0.0 src/`a.ts`/f().',
      roles: 0,
    }]);
  });

  it('rejects an index with no documents', () => {
    expect(() => decodeScipIndex(Buffer.alloc(0))).not.toThrow();
    expect(() => loadScipIndex(__filename)).toThrow();
  });

  it('parses descriptor chains', () => {
    expect(parseSymbol('scip-python python django 1.0 `django.urls.base`/reverse().')).toEqual({
      owner: 'scip-python python django 1.0 `django.urls.base`/',
      last: { name: 'reverse', kind: 'method' },
    });
    expect(parseSymbol('scip-typescript npm p 1.0.0 src/`m.ts`/Invoice#`<constructor>`().')?.last)
      .toEqual({ name: '<constructor>', kind: 'method' });
    expect(parseSymbol('rust-analyzer cargo foo 0.1.0 impl#[Foo][Bar]baz().')?.last).toEqual({ name: 'baz', kind: 'method' });
    expect(parseSymbol('scip-go gomod example.com/x v1 `example.com/x`/Server#Serve(+1).')?.last)
      .toEqual({ name: 'Serve', kind: 'method' });
    expect(parseSymbol('local 12')).toBeNull();
  });

  it('recognizes call shapes', () => {
    expect(looksLikeCall('(1)')).toBe(true);
    expect(looksLikeCall(' ?.(x)')).toBe(true);
    expect(looksLikeCall('<Map<string, number>>(x)')).toBe(true);
    expect(looksLikeCall(', cb)')).toBe(false);
    expect(looksLikeCall(' < 3')).toBe(false);
  });
});
