import { expect, it } from 'vitest';
import { importMappedSemantics } from '../src/hdl/source-map-import';
const sources = { 'inc/ports.svh': '`define P(N) input logic N\r\n', 'top.sv': '// Ω\r\nmodule top(`P(data)); endmodule\r\n' };
const point = (file: keyof typeof sources, offset: number) => {
  const prefix = Buffer.from(sources[file]).subarray(0, offset);
  const line = [...prefix].filter(v => v === 10).length + 1;
  return { file, line, column: offset - prefix.lastIndexOf(10), byteOffset: offset };
};
const start = Buffer.from(sources['top.sv']).indexOf('`P');
const payload = () => ({ codegraphSemanticVersion: 1, facts: [{ kind: 'port', name: 'data', instancePath: 'top', type: 'logic', width: 1,
  sourceOrigin: 'macro', source: { file: 'top.sv', line: 2, column: 15 }, macroExpansionComplete: true,
  macroExpansion: [{ name: 'P', argument: false, spelling: point('inc/ports.svh', 24), invocation: { start: point('top.sv', start), end: point('top.sv', start + 8) } }],
}] });
it('preserves compiler byte coordinates and macro call/spelling across headers, UTF8 and CRLF', () => {
  const result = importMappedSemantics(payload(), sources);
  expect(result[0].macroExpansion?.[0]).toEqual(payload().facts[0]!.macroExpansion[0]);
  expect(result[0].sourceOrigin).toBe('macro');
});
it('rejects tampered source paths, byte offsets, reversed ranges and UTF8 continuation positions', () => {
  let p = payload(); p.facts[0]!.macroExpansion[0]!.spelling.file = '../secret' as any;
  expect(() => importMappedSemantics(p, sources)).toThrow('outside snapshot');
  p = payload(); p.facts[0]!.macroExpansion[0]!.spelling.byteOffset++;
  expect(() => importMappedSemantics(p, sources)).toThrow('disagree');
  p = payload(); const range = p.facts[0]!.macroExpansion[0]!.invocation; [range.start, range.end] = [range.end, range.start];
  expect(() => importMappedSemantics(p, sources)).toThrow('order');
  p = payload(); p.facts[0]!.macroExpansion[0]!.spelling = point('top.sv', 4);
  expect(() => importMappedSemantics(p, sources)).toThrow('UTF-8');
});
it('does not accept invented complete chains or duplicate identities', () => {
  const p = payload(); p.facts[0]!.macroExpansion = [];
  expect(() => importMappedSemantics(p, sources)).toThrow('complete');
  p.facts[0]!.macroExpansionComplete = false;
  expect(importMappedSemantics(p, sources)[0].macroExpansionComplete).toBe(false);
  p.facts.push(p.facts[0]!);
  expect(() => importMappedSemantics(p, sources)).toThrow('duplicate');
});
it('rejects line/offset disagreement at a newline and unsupported schema', () => {
  const p = payload(); p.facts[0]!.macroExpansion[0]!.spelling = { file: 'top.sv', line: 1, column: 8, byteOffset: 7 };
  expect(() => importMappedSemantics(p, sources)).toThrow('column');
  expect(() => importMappedSemantics({ codegraphSemanticVersion: 2, facts: [] }, sources)).toThrow('schema');
});
