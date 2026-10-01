/**
 * An index reduced to what the merge reads, written once when it is built.
 *
 * Indexers record every mention of every symbol — locals, parameters, type
 * annotations, imports, namespaces. The merge needs two things: definitions
 * of callables and types (to map symbols onto codegraph nodes, and to tell a
 * project symbol from an external one), and references that read as a call,
 * `new`, or struct literal. Everything else is dropped. The result is still a
 * standard SCIP index, a fraction of the size, and it decodes in a fraction of
 * the time on every later merge. Implementation relationships between those
 * symbols (class → base, method → the method it implements) are kept too. The merge re-checks the call shape against
 * the (hash-gated, identical) source, so compaction can't change an outcome.
 *
 * Indexer outputs are added one at a time and only the current document is
 * held — a split run's parts never need to be concatenated in memory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { INDEXERS } from './indexers';
import { IndexMeta, ParsedSymbol, ROLE_DEFINITION, ScipOccurrence, encodeDocument, encodeMetadata, parseSymbol, scanIndex } from './reader';
import type { ScipLanguage } from './store';
import { callShape, isCallTarget, siteKind } from './syntax';

export class Compactor {
  meta: IndexMeta | null = null;
  /** repo-relative paths of the documents kept, in order */
  readonly paths: string[] = [];
  private seen = new Set<string>();
  private defined = new Set<string>();
  private callRefs = new Map<string, number>();
  private parsed = new Map<string, ParsedSymbol | null>();
  private symbols = new Map<string, Buffer>();
  private chunks: Buffer[] = [];

  constructor(private readonly projectRoot: string, private readonly lang: ScipLanguage) {}

  /** Adds one indexer output. A file already added (overlapping projects) keeps its first document. */
  add(index: Buffer): void {
    const literal = INDEXERS[this.lang].literalShape;
    const meta = scanIndex(index, doc => {
      if (this.seen.has(doc.relativePath)) return;
      this.seen.add(doc.relativePath);
      const lines = readLines(path.join(this.projectRoot, doc.relativePath));
      const kept: ScipOccurrence[] = [];
      for (const o of doc.occurrences) {
        const kind = this.parse(o.symbol)?.last.kind; // undefined for locals
        if (!isCallTarget(kind)) continue;
        if (o.roles & ROLE_DEFINITION) {
          kept.push(o);
          this.defined.add(o.symbol);
          continue;
        }
        if (!lines) continue; // unreadable now: the merge would treat the file as stale anyway
        if (!siteKind(kind, () => callShape(o, doc.positionEncoding, lines, literal))) continue;
        kept.push(o);
        this.callRefs.set(o.symbol, (this.callRefs.get(o.symbol) ?? 0) + 1);
      }
      // Class → base/interface and method → the method it implements: what `implements`/`extends`
      // edges and calls made through an interface are judged by (see relations.ts).
      const implementations = (doc.implementations ?? []).filter(i =>
        isCallTarget(this.parse(i.symbol)?.last.kind) && isCallTarget(this.parse(i.target)?.last.kind));
      this.chunks.push(encodeDocument({ ...doc, occurrences: kept, implementations }, s => this.bytes(s)));
      this.paths.push(doc.relativePath);
    }, this.projectRoot);
    this.meta ??= meta;
  }

  /**
   * Calls and instantiations the compiler resolved to a symbol the project itself
   * defines — the regression guard's measure of how much the index resolved.
   * Imports and type references don't count: a broken build can keep those while
   * call resolution collapses.
   */
  resolvedCalls(): number {
    let n = 0;
    for (const [symbol, count] of this.callRefs) if (this.defined.has(symbol)) n += count;
    return n;
  }

  /** Writes the compact index to `file` (the caller makes it atomic where it matters). */
  write(file: string): void {
    const fd = fs.openSync(file, 'w');
    try {
      if (this.meta) fs.writeSync(fd, encodeMetadata({ ...this.meta, projectRoot: pathToFileURL(this.projectRoot).href })); // paths are rebased onto it
      for (const c of this.chunks) fs.writeSync(fd, c);
    } finally {
      fs.closeSync(fd);
    }
  }

  private parse(symbol: string): ParsedSymbol | null {
    let p = this.parsed.get(symbol);
    if (p === undefined) this.parsed.set(symbol, (p = parseSymbol(symbol)));
    return p;
  }

  private bytes(symbol: string): Buffer {
    let b = this.symbols.get(symbol);
    if (!b) this.symbols.set(symbol, (b = Buffer.from(symbol)));
    return b;
  }
}

function readLines(file: string): string[] | null {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}
