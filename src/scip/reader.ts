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
import * as path from 'path';
import { fileURLToPath } from 'url';

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

/** `symbol` implements (or overrides) `target` — a class its base or interface, a method the one it implements. */
export interface ScipImplementation {
  symbol: string;
  target: string;
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  positionEncoding: number;
  occurrences: ScipOccurrence[];
  /** from the document's SymbolInformation relationships marked `is_implementation` */
  implementations?: ScipImplementation[];
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

/** SymbolInformation (symbol=1, relationships=4 → Relationship: symbol=1, is_implementation=3); everything else skipped. */
function readSymbolInformation(r: Reader, into: ScipImplementation[]): void {
  let symbol = '';
  const targets: string[] = [];
  while (!r.done()) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1) symbol = r.string();
    else if (field === 4) {
      const rel = r.sub();
      let target = '';
      let impl = false;
      while (!rel.done()) {
        const t = rel.varint();
        const f = Math.floor(t / 8);
        if (f === 1) target = rel.string();
        else if (f === 3 && (t & 7) === WIRE_VARINT) impl = rel.varint() !== 0;
        else rel.skip(t & 7);
      }
      if (impl && target) targets.push(target);
    } else r.skip(wire);
  }
  if (symbol) for (const target of targets) into.push({ symbol, target });
}

function readDocument(r: Reader): ScipDocument {
  const doc: ScipDocument = { relativePath: '', language: '', positionEncoding: 0, occurrences: [], implementations: [] };
  while (!r.done()) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (field === 1) doc.relativePath = r.string();
    else if (field === 2) {
      const o = readOccurrence(r.sub());
      if (o) doc.occurrences.push(o);
    } else if (field === 3) readSymbolInformation(r.sub(), doc.implementations!);
    else if (field === 4) doc.language = r.string();
    else if (field === 6) doc.positionEncoding = r.varint();
    else r.skip(wire);
  }
  return doc;
}

export type IndexMeta = Omit<ScipIndex, 'documents'>;

/**
 * Walks an index one document at a time — nothing but the current document is
 * held, so a multi-GB index can be filtered without decoding it whole.
 * Concatenated indexes (one per sub-project, see IndexerRun) read as one.
 */
export function scanIndex(buf: Buffer, onDocument?: (doc: ScipDocument) => void, projectRoot?: string): IndexMeta {
  const meta: IndexMeta = { toolName: '', toolVersion: '', projectRoot: '' };
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
            if (tf === 1) meta.toolName = tool.string();
            else if (tf === 2) meta.toolVersion = tool.string();
            else tool.skip(tt & 7);
          }
        } else if (f === 3) meta.projectRoot = m.string();
        else m.skip(t & 7);
      }
    } else if (field === 2 && wire === WIRE_LEN && onDocument) {
      const doc = readDocument(r.sub());
      const rel = doc.relativePath && projectRoot !== undefined ? rebase(meta.projectRoot, projectRoot, doc.relativePath) : doc.relativePath;
      if (rel) onDocument({ ...doc, relativePath: rel });
    } else { // including documents when only the metadata is wanted
      r.skip(wire);
    }
  }
  return meta;
}

/**
 * Decodes a whole index. A file claimed by two overlapping projects keeps its
 * first document — the indexers here emit each file once per run, and a second
 * copy only repeats the same occurrences. With `projectRoot`, paths are rebased
 * onto it (see rebase).
 */
export function decodeScipIndex(buf: Buffer, projectRoot?: string): ScipIndex {
  const documents: ScipDocument[] = [];
  const seen = new Set<string>();
  const meta = scanIndex(buf, doc => {
    if (seen.has(doc.relativePath)) return;
    seen.add(doc.relativePath);
    documents.push(doc);
  }, projectRoot);
  return { ...meta, documents };
}

/**
 * A document path made relative to `projectRoot`. An index rooted at a folder
 * inside the project (scip-python's `--target-only` run, an index built in a
 * subfolder) has its paths prefixed with that folder; one rooted elsewhere (built
 * on another machine) keeps them. Null for a path that leaves the project.
 */
function rebase(indexRoot: string, projectRoot: string, relativePath: string): string | null {
  let prefix = '';
  if (indexRoot.startsWith('file:')) {
    const inner = path.relative(projectRoot, fileURLToPath(indexRoot));
    if (!inner.startsWith('..') && !path.isAbsolute(inner)) prefix = inner.split(path.sep).join('/');
  }
  const rel = path.posix.normalize(path.posix.join(prefix, relativePath));
  return rel === '..' || rel.startsWith('../') ? null : rel;
}

// --- protobuf wire encoding (the same subset) ------------------------------------

/**
 * A growable protobuf byte buffer: varints byte by byte, everything else copied
 * natively. A nested message is written into a scratch writer, then copied in
 * with its length — one copy per level, not one array push per byte.
 */
class Writer {
  private buf = new Uint8Array(1024);
  private len = 0;

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  varint(n: number): void {
    this.room(10);
    while (n > 0x7f) {
      this.buf[this.len++] = (n & 0x7f) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.len++] = n;
  }

  /** A length-delimited field. */
  bytes(field: number, bytes: Uint8Array): void {
    this.varint(field * 8 + WIRE_LEN);
    this.varint(bytes.length);
    this.room(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** A nested message: `fill` writes it into `scratch` (emptied first). */
  message(field: number, scratch: Writer, fill: (w: Writer) => void): void {
    scratch.len = 0;
    fill(scratch);
    this.bytes(field, scratch.buf.subarray(0, scratch.len));
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }
}

/** Index metadata: tool name/version and project root — what the reader reads back. */
export function encodeMetadata(meta: IndexMeta): Buffer {
  const out = new Writer();
  out.message(1, new Writer(), m => {
    m.message(2, new Writer(), tool => {
      tool.bytes(1, Buffer.from(meta.toolName));
      tool.bytes(2, Buffer.from(meta.toolVersion));
    });
    if (meta.projectRoot) m.bytes(3, Buffer.from(meta.projectRoot));
  });
  return out.toBuffer();
}

// encodeDocument's scratch writers, one per nesting level: encoding is synchronous, so one set serves every call.
const docW = new Writer();
const occW = new Writer();
const rangeW = new Writer();
const infoW = new Writer();
const relW = new Writer();

/**
 * One `Index.documents` entry. Ranges are written as the packed int32 field —
 * three numbers for a single-line range — the densest form every SCIP reader accepts.
 */
export function encodeDocument(doc: ScipDocument, symbolBytes: (symbol: string) => Buffer): Buffer {
  const out = new Writer();
  out.message(2, docW, d => {
    d.bytes(1, Buffer.from(doc.relativePath));
    for (const o of doc.occurrences) {
      d.message(2, occW, occ => {
        const { startLine, startCol, endLine, endCol } = o.range;
        occ.message(1, rangeW, r => {
          r.varint(startLine);
          r.varint(startCol);
          if (startLine !== endLine) r.varint(endLine);
          r.varint(endCol);
        });
        occ.bytes(2, symbolBytes(o.symbol));
        if (o.roles) {
          occ.varint(3 * 8 + WIRE_VARINT);
          occ.varint(o.roles);
        }
      });
    }
    const bySymbol = new Map<string, string[]>();
    for (const { symbol, target } of doc.implementations ?? []) {
      const t = bySymbol.get(symbol);
      if (t) t.push(target);
      else bySymbol.set(symbol, [target]);
    }
    for (const [symbol, targets] of bySymbol) {
      d.message(3, infoW, info => {
        info.bytes(1, symbolBytes(symbol));
        for (const target of targets) {
          info.message(4, relW, rel => {
            rel.bytes(1, symbolBytes(target));
            rel.varint(3 * 8 + WIRE_VARINT);
            rel.varint(1);
          });
        }
      });
    }
    if (doc.language) d.bytes(4, Buffer.from(doc.language));
    if (doc.positionEncoding) {
      d.varint(6 * 8 + WIRE_VARINT);
      d.varint(doc.positionEncoding);
    }
  });
  return out.toBuffer();
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

function isLocalSymbol(symbol: string): boolean {
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

const PLAIN_IDENTIFIER = /^[\w+$-]+$/;

/** A descriptor name as SCIP spells it — plain when it can be, else backtick-quoted — so parseSymbol reads it back. */
export function escapeIdentifier(name: string): string {
  return PLAIN_IDENTIFIER.test(name) ? name : '`' + name.replace(/`/g, '``') + '`';
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
  while (j < s.length && PLAIN_IDENTIFIER.test(s[j]!)) j++;
  return j > i ? { name: s.slice(i, j), end: j } : null;
}
