import { createHash } from 'node:crypto';
import type { ExtractionResult, Language } from '../types';

/** Internal per-graph optimization. Never stores extension/framework output.
 * Keeps the first working set that fits instead of cycling an oversized scan
 * through an LRU and evicting every entry before its next use. No disk format,
 * API dependency declaration or cross-project cache is introduced.
 */
export class CoreExtractionReuse {
  private entries = new Map<string, { key: string; result: ExtractionResult; bytes: number }>();
  private bytes = 0;
  hits = 0;
  misses = 0;
  constructor(private readonly budget = 128 * 1024 * 1024) {}
  private key(content: string, language: Language): string {
    // These switches may change core extraction routes during a long-lived
    // process. Conservatively invalidate on any engine environment change.
    const environment = Object.keys(process.env).filter(k => k.startsWith('CODEGRAPH_')).sort().map(k => [k, process.env[k]]);
    return createHash('sha256').update(JSON.stringify([language, environment])).update(content).digest('hex');
  }
  get(file: string, content: string, language: Language): ExtractionResult | undefined {
    const entry = this.entries.get(file), key = this.key(content, language);
    if (entry?.key === key) { this.hits++; return entry.result; }
    if (entry) { this.entries.delete(file); this.bytes -= entry.bytes; }
    this.misses++; return undefined;
  }
  set(file: string, content: string, language: Language, result: ExtractionResult): void {
    if (result.errors.length || result.kernelBuffers) return; // retry transient/partial extraction
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8') * 2;
    const old = this.entries.get(file);
    if (old) { this.entries.delete(file); this.bytes -= old.bytes; }
    if (bytes > this.budget - this.bytes) return;
    this.entries.set(file, { key: this.key(content, language), result, bytes }); this.bytes += bytes;
  }
  retain(files: readonly string[]): void {
    const keep = new Set(files);
    for (const [file, entry] of this.entries) if (!keep.has(file)) { this.entries.delete(file); this.bytes -= entry.bytes; }
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  stats(): { hits: number; misses: number; bytes: number; entries: number } {
    return { hits: this.hits, misses: this.misses, bytes: this.bytes, entries: this.entries.size };
  }
}

/** Internal worker transport. The base must be cloned before framework hooks. */
export type ReusableExtraction = ExtractionResult & { coreExtraction?: ExtractionResult };
