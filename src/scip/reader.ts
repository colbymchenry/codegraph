/**
 * Minimal SCIP index reader.
 *
 * Decodes only the fields the SCIP merge uses, straight from the protobuf wire
 * format, so the fork ships no protobuf runtime or generated code. Field numbers
 * follow https://github.com/sourcegraph/scip/blob/main/scip.proto — both the
 * deprecated `repeated int32` range and the typed `SingleLineRange` /
 * `MultiLineRange` replacements are accepted (typed wins when both are set).
 */

import * as fs from 'fs';

/** `SymbolRole.Definition` bit. */
export const ROLE_DEFINITION = 0x1;

/** `PositionEncoding.UTF8CodeUnitOffsetFromLineStart`. Anything else is read as UTF-16 (JS string offsets). */
export const POSITION_ENCODING_UTF8 = 1;

/** Half-open, 0-based source span — SCIP's convention. */
export interface Span {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface ScipOccurrence {
  range: Span;
  symbol: string;
  roles: number;
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  positionEncoding: number;
  occurrences: ScipOccurrence[];
}

export interface ScipIndex {
  toolName: string;
  toolVersion: string;
  projectRoot: string;
  documents: ScipDocument[];
}

export class ScipDecodeError extends Error {}

function spanOf(r: number[]): Span | null {
  if (r.length === 3) return { startLine: r[0]!, startCol: r[1]!, endLine: r[0]!, endCol: r[2]! };
  if (r.length === 4) return { startLine: r[0]!, startCol: r[1]!, endLine: r[2]!, endCol: r[3]! };
  return null;
}

// --- protobuf wire decoding -------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

class Reader {
  pos: number;
  constructor(readonly buf: Buffer, start: number, readonly end: number) {
    this.pos = start;
  }

  done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    // Values here (field tags, lengths, int32 coordinates, role bitsets) fit in
    // 53 bits; negative int32s arrive as 10-byte varints and are folded back.
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new ScipDecodeError('truncated varint');
      const b = this.buf[this.pos++]!;
      if (shift < 49) result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 70) throw new ScipDecodeError('varint too long');
    }
    return result > 0x7fffffff && result <= 0xffffffff ? result - 0x100000000 : result;
  }

  /** Returns [start, end) of a length-delimited field and advances past it. */
  bytes(): [number, number] {
    const len = this.varint();
    const start = this.pos;
    const end = start + len;
    if (len < 0 || end > this.end) throw new ScipDecodeError('length-delimited field overruns its message');
    this.pos = end;
    return [start, end];
  }

  string(): string {
    const [s, e] = this.bytes();
    return this.buf.toString('utf8', s, e);
  }

  skip(wire: number): void {
    if (wire === WIRE_VARINT) this.varint();
    else if (wire === WIRE_I64) this.pos += 8;
    else if (wire === WIRE_LEN) this.bytes();
    else if (wire === WIRE_I32) this.pos += 4;
    else throw new ScipDecodeError(`unsupported wire type ${wire}`);
  }

  sub(): Reader {
    const [s, e] = this.bytes();
    return new Reader(this.buf, s, e);
  }

  /** `repeated int32`, packed or not. */
  int32s(wire: number, into: number[]): void {
    if (wire === WIRE_LEN) {
      const r = this.sub();
      while (!r.done()) into.push(r.varint());
    } else {
      into.push(this.varint());
    }
  }
}

function readTyped(r: Reader, multi: boolean): Span {
  const v = [0, 0, 0, 0];
  while (!r.done()) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field >= 1 && field <= 4 && wire === WIRE_VARINT) v[field - 1] = r.varint();
    else r.skip(wire);
  }
  // SingleLineRange: line=1, start_character=2, end_character=3.
  return multi
    ? { startLine: v[0]!, startCol: v[1]!, endLine: v[2]!, endCol: v[3]! }
    : { startLine: v[0]!, startCol: v[1]!, endLine: v[0]!, endCol: v[2]! };
}

// Enclosing ranges (fields 7/10/11) are skipped: a call's caller comes from
// codegraph's own node spans, which is what its edges are keyed by (sites.ts).
function readOccurrence(r: Reader): ScipOccurrence | null {
  const legacyRange: number[] = [];
  let typedRange: Span | null = null;
  let symbol = '';
  let roles = 0;
  while (!r.done()) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    switch (field) {
      case 1: r.int32s(wire, legacyRange); break;
      case 2: symbol = r.string(); break;
      case 3: roles = r.varint(); break;
      case 8: typedRange = readTyped(r.sub(), false); break;
      case 9: typedRange = readTyped(r.sub(), true); break;
      default: r.skip(wire);
    }
  }
  const range = typedRange ?? spanOf(legacyRange);
  if (!range) return null; // malformed occurrence — nothing to anchor it to
  return { range, symbol, roles };
}

function readDocument(r: Reader): ScipDocument {
  const doc: ScipDocument = { relativePath: '', language: '', positionEncoding: 0, occurrences: [] };
  while (!r.done()) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1) doc.relativePath = r.string();
    else if (field === 2) {
      const o = readOccurrence(r.sub());
      if (o) doc.occurrences.push(o);
    } else if (field === 4) doc.language = r.string();
    else if (field === 6) doc.positionEncoding = r.varint();
    else r.skip(wire);
  }
  return doc;
}

export function decodeScipIndex(buf: Buffer): ScipIndex {
  const ix: ScipIndex = { toolName: '', toolVersion: '', projectRoot: '', documents: [] };
  const r = new Reader(buf, 0, buf.length);
  while (!r.done()) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1 && wire === WIRE_LEN) {
      const m = r.sub();
      while (!m.done()) {
        const t = m.varint();
        const f = Math.floor(t / 8);
        if (f === 2) {
          const tool = m.sub();
          while (!tool.done()) {
            const tt = tool.varint();
            const tf = Math.floor(tt / 8);
            if (tf === 1) ix.toolName = tool.string();
            else if (tf === 2) ix.toolVersion = tool.string();
            else tool.skip(tt & 7);
          }
        } else if (f === 3) ix.projectRoot = m.string();
        else m.skip(t & 7);
      }
    } else if (field === 2 && wire === WIRE_LEN) {
      const doc = readDocument(r.sub());
      if (doc.relativePath) ix.documents.push(doc);
    } else {
      r.skip(wire);
    }
  }
  return ix;
}

/** Reads and decodes a `.scip` file; an index with no documents is an indexer failure, not an empty project. */
export function loadScipIndex(file: string): ScipIndex {
  const ix = decodeScipIndex(fs.readFileSync(file));
  if (ix.documents.length === 0) {
    throw new ScipDecodeError(`${file} has no documents — the indexer failed or this is not a SCIP index`);
  }
  return ix;
}

// --- symbols ------------------------------------------------------------------

export type DescriptorKind = 'namespace' | 'type' | 'term' | 'method' | 'type-parameter' | 'parameter' | 'meta' | 'macro';

export interface Descriptor {
  name: string;
  kind: DescriptorKind;
}

export interface ParsedSymbol {
  /** Everything before the last descriptor — the owner's symbol string. */
  owner: string;
  last: Descriptor;
}

export function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith('local ');
}

const SUFFIX: Record<string, DescriptorKind> = {
  '/': 'namespace', '#': 'type', '.': 'term', ':': 'meta', '!': 'macro',
};

/**
 * Parses the descriptor chain of a global symbol
 * (`<scheme> <manager> <package> <version> <descriptors>`) and returns its last
 * descriptor plus the owner prefix. Null for local or malformed symbols.
 */
export function parseSymbol(symbol: string): ParsedSymbol | null {
  if (!symbol || isLocalSymbol(symbol)) return null;
  // Skip the four space-separated header fields; a literal space inside one is escaped as two spaces.
  let i = 0;
  for (let field = 0; field < 4; field++) {
    for (;;) {
      const sp = symbol.indexOf(' ', i);
      if (sp < 0) return null;
      if (symbol[sp + 1] === ' ') { i = sp + 2; continue; }
      i = sp + 1;
      break;
    }
  }
  let last: Descriptor | null = null;
  let lastStart = i;
  while (i < symbol.length) {
    const start = i;
    let name: string;
    let kind: DescriptorKind;
    if (symbol[i] === '[' || symbol[i] === '(') {
      const close = symbol[i] === '[' ? ']' : ')';
      const readName = readIdentifier(symbol, i + 1);
      if (!readName || symbol[readName.end] !== close) return null;
      name = readName.name;
      kind = close === ']' ? 'type-parameter' : 'parameter';
      i = readName.end + 1;
    } else {
      const readName = readIdentifier(symbol, i);
      if (!readName) return null;
      name = readName.name;
      i = readName.end;
      const c = symbol[i];
      if (c === '(') {
        const close = symbol.indexOf(').', i);
        if (close < 0) return null;
        kind = 'method';
        i = close + 2;
      } else if (c !== undefined && SUFFIX[c]) {
        kind = SUFFIX[c]!;
        i++;
      } else {
        return null;
      }
    }
    last = { name, kind };
    lastStart = start;
  }
  return last ? { owner: symbol.slice(0, lastStart), last } : null;
}

function readIdentifier(s: string, i: number): { name: string; end: number } | null {
  if (s[i] === '`') {
    let name = '';
    let j = i + 1;
    for (;;) {
      if (j >= s.length) return null;
      if (s[j] === '`') {
        if (s[j + 1] === '`') { name += '`'; j += 2; continue; }
        return { name, end: j + 1 };
      }
      name += s[j++];
    }
  }
  let j = i;
  while (j < s.length && /[\w+$-]/.test(s[j]!)) j++;
  return j > i ? { name: s.slice(i, j), end: j } : null;
}
