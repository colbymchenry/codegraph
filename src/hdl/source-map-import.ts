import * as path from 'node:path';
import type { HdlSemanticFact, HdlMacroPoint, HdlMacroFrame, HdlExpressionCoverage, HdlExpressionOrigin } from './semantic-import';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(message: string): never { throw new Error('Invalid pyslang semantic export: ' + message); }

/** Validate the separately versioned exporter protocol against immutable source bytes. */
export function importMappedSemantics(value: unknown, sources: Record<string, string>): HdlSemanticFact[] {
  if (!object(value) || value.codegraphSemanticVersion !== 1 || !Array.isArray(value.facts) || value.facts.length > 100000) fail('unsupported schema or fact count');
  const cache = new Map<string, { bytes: Buffer; starts: number[] }>();
  const fileData = (file: unknown) => {
    if (typeof file !== 'string' || !file || file.includes('\\') || file.includes('\0') || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || path.posix.normalize(file) !== file || file.split('/').includes('..') || !Object.prototype.hasOwnProperty.call(sources, file)) fail('source outside snapshot');
    if (!cache.has(file)) {
      const bytes = Buffer.from(sources[file]!, 'utf8'), starts = [0];
      for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) starts.push(i + 1);
      cache.set(file, { bytes, starts });
    }
    return { file, ...cache.get(file)! };
  };
  const source = (v: unknown): NonNullable<HdlSemanticFact['source']> => {
    if (!object(v)) fail('source must be an object');
    const data = fileData(v.file), line = v.line, column = v.column;
    if (!Number.isSafeInteger(line) || (line as number) < 1 || (line as number) > data.starts.length || (column !== null && (!Number.isSafeInteger(column) || (column as number) < 1))) fail('invalid source coordinates');
    if (column !== null) {
      const offset = data.starts[(line as number) - 1]! + (column as number) - 1;
      const end = data.starts[line as number] ?? data.bytes.length;
      if (((line as number) < data.starts.length && offset >= end) || offset > end || offset > data.bytes.length || (offset < data.bytes.length && (data.bytes[offset]! & 0xc0) === 0x80)) fail('column outside source line or inside UTF-8 code point');
    }
    return { file: data.file, line: line as number, column: column as number | null };
  };
  const point = (v: unknown): HdlMacroPoint => {
    const location = source(v);
    if (!object(v) || location.column === null || !Number.isSafeInteger(v.byteOffset) || (v.byteOffset as number) < 0) fail('invalid source byte offset');
    const data = fileData(location.file);
    if (data.starts[location.line - 1]! + location.column! - 1 !== v.byteOffset) fail('source coordinates disagree with byte offset');
    return { ...location, column: location.column!, byteOffset: v.byteOffset as number };
  };
  const text = (v: unknown, label: string, max = 4096): string => {
    if (typeof v !== 'string' || !v || v.length > max || v.includes('\0')) fail('invalid ' + label);
    return v;
  };
  const result: HdlSemanticFact[] = [];
  const identities = new Set<string>();
  let frames = 0;
  const macro = (item: Record<string, unknown>): Omit<HdlExpressionOrigin, 'role' | 'sourceOrigin'> => {
    if (!Array.isArray(item.macroExpansion) || item.macroExpansion.length > 128 || typeof item.macroExpansionComplete !== 'boolean') fail('invalid macro chain');
    frames += item.macroExpansion.length;
    if (frames > 100000) fail('macro frame count limit');
    const macroExpansion = item.macroExpansion.map((frame: unknown): HdlMacroFrame => {
      if (!object(frame) || typeof frame.argument !== 'boolean') fail('invalid macro frame');
      const out: HdlMacroFrame = { name: frame.name === null ? null : text(frame.name, 'macro name'), argument: frame.argument };
      if (frame.spelling !== undefined) out.spelling = point(frame.spelling);
      if (frame.invocation !== undefined) {
        if (!object(frame.invocation)) fail('invalid invocation range');
        out.invocation = { start: point(frame.invocation.start), end: point(frame.invocation.end) };
        if (out.invocation.start.file !== out.invocation.end.file || out.invocation.start.byteOffset > out.invocation.end.byteOffset) fail('invalid invocation order');
      }
      return out;
    });
    const macroExpansionComplete = item.macroExpansionComplete;
    if (macroExpansionComplete && (!macroExpansion.length || macroExpansion.some(f => !f.spelling || !f.invocation || f.invocation.start.byteOffset === f.invocation.end.byteOffset))) fail('incomplete chain marked complete');
    return { macroExpansion, macroExpansionComplete, ...(item.source !== undefined ? { source: source(item.source) } : {}) };
  };
  for (const item of value.facts) {
    if (!object(item) || (item.kind !== 'parameter' && item.kind !== 'port' && item.kind !== 'type') || (item.sourceOrigin !== 'direct' && item.sourceOrigin !== 'macro')) fail('invalid fact kind/origin');
    const fact: HdlSemanticFact = { kind: item.kind, name: text(item.name, 'name'), instancePath: text(item.instancePath, 'instance path'), sourceOrigin: item.sourceOrigin };
    const id = JSON.stringify([fact.instancePath, fact.kind, fact.name]);
    if (identities.has(id)) fail('duplicate instance fact'); identities.add(id);
    if (item.value !== undefined) fact.value = text(item.value, 'value', 65536);
    if (item.type !== undefined) fact.type = text(item.type, 'type', 65536);
    if (item.width !== undefined) {
      if (!Number.isSafeInteger(item.width) || (item.width as number) < 1) fail('invalid width');
      fact.width = item.width as number;
    }
    if (item.direction !== undefined) fact.direction = text(item.direction, 'direction');
    if (item.source !== undefined) fact.source = source(item.source);
    if (item.sourceOrigin === 'macro') Object.assign(fact, macro(item));
    else if (item.macroExpansion !== undefined || item.macroExpansionComplete !== undefined) fail('direct fact carries macro chain');
    if (item.expressionOrigins !== undefined || item.expressionOriginCoverage !== undefined) {
      if (!Array.isArray(item.expressionOrigins) || item.expressionOrigins.length > 32 || !object(item.expressionOriginCoverage)) fail('invalid expression origins');
      const coverage = item.expressionOriginCoverage;
      const statuses = ['checked', 'not-applicable', 'unavailable'];
      if (typeof coverage.initializer !== 'string' || typeof coverage.declaredInitializer !== 'string' || typeof coverage.type !== 'string' || ![...statuses, 'command-line'].includes(coverage.initializer) || !statuses.includes(coverage.declaredInitializer) || !statuses.includes(coverage.type) || typeof coverage.truncated !== 'boolean') fail('invalid expression coverage');
      fact.expressionOriginCoverage = { initializer: coverage.initializer, declaredInitializer: coverage.declaredInitializer, type: coverage.type, truncated: coverage.truncated } as HdlExpressionCoverage;
      const keys = { initializer: 'initializer', 'declared-initializer': 'declaredInitializer', type: 'type' } as const;
      const seen = new Set<string>();
      fact.expressionOrigins = item.expressionOrigins.map((entry: unknown): HdlExpressionOrigin => {
        if (!object(entry) || (entry.role !== 'initializer' && entry.role !== 'declared-initializer' && entry.role !== 'type') || entry.sourceOrigin !== 'macro') fail('invalid expression origin role');
        const status = coverage[keys[entry.role]];
        if (status !== 'checked' && status !== 'command-line') fail('expression origin contradicts coverage');
        const normalized: HdlExpressionOrigin = { role: entry.role, sourceOrigin: 'macro', ...macro(entry) };
        const key = JSON.stringify(normalized);
        if (seen.has(key)) fail('duplicate expression origin'); seen.add(key);
        return normalized;
      });
    }
    result.push(fact);
  }
  return result;
}
