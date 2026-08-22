/**
 * Parse Worker
 *
 * Runs tree-sitter parsing in a separate thread so the main thread
 * stays unblocked and the UI animation renders smoothly.
 */

// Compile cache FIRST: the worker's boot cost is dominated by re-requiring
// the extraction module graph; the persistent V8 cache (Node ≥22.8) makes
// that a bytecode load instead of a recompile. Safe no-op when unavailable.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch { /* cache is best-effort */ }

import { parentPort } from 'worker_threads';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, loadGrammarsForLanguages, resetParser } from './grammars';
import { tryKernelExtractRaw } from './kernel';
import { getAllFrameworkResolvers, getApplicableFrameworks } from '../resolution/frameworks';
import type { Language, ExtractionResult } from '../types';

// Emscripten prints `Aborted()` (and a follow-up RuntimeError diag
// line) directly to stderr when WASM aborts — before the JS catch
// runs. Worker stderr is inherited by the parent, so each crash leaks
// a noise line to the user's terminal even though the JS layer
// already handles the failure cleanly. Filter these specific lines
// out at the source. Real diagnostic output (anything we log
// ourselves) goes through console.* / parentPort and is unaffected.
//
// Caveats deliberately accepted:
//   - Per-call match: each `write()` call is matched in isolation.
//     If Emscripten ever splits `Aborted(` across two write()s (it
//     doesn't today — synchronous abort prints the whole line at
//     once via libc puts) the first fragment would leak. Buffering
//     across calls would add complexity for a hypothetical case.
//   - Substring exactness: the prefix `Aborted(` is the literal
//     Emscripten signature. Any user code that legitimately writes
//     a stderr line starting with that prefix would also be filtered;
//     in practice no real diagnostic does.
{
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (
      s.startsWith('Aborted(') ||
      s.includes('Build with -sASSERTIONS for more info')
    ) {
      // Honour the Writable stream contract: callbacks must always
      // fire even when the write is suppressed, or upstream code
      // waiting on the drain signal would hang. Both overload forms
      // are handled (`(chunk, cb)` and `(chunk, encoding, cb)`).
      if (typeof encoding === 'function') encoding();
      else if (cb) cb();
      return true;
    }
    return realWrite(chunk as never, encoding as never, cb as never);
  }) as typeof process.stderr.write;
}

const PARSER_RESET_INTERVAL = 5000;
const parseCounts = new Map<Language, number>();

parentPort!.on('message', async (msg: { type: string; id?: number; filePath?: string; content?: string; languages?: Language[]; frameworkNames?: string[]; language?: Language; grammarBuffers?: Record<string, Uint8Array> }) => {
  if (msg.type === 'load-grammars') {
    // Grammar WASM bytes pre-read by the main thread (when provided) make this
    // a memory load instead of a per-spawn disk read — see issue #1231.
    await loadGrammarsForLanguages(msg.languages!, msg.grammarBuffers);
    parentPort!.postMessage({ type: 'grammars-loaded' });
  } else if (msg.type === 'parse') {
    const { id, filePath, content, frameworkNames } = msg;
    // Worker-side parse clock: reported back with the result so the pool can
    // tell a genuinely slow parse from a result whose delivery was delayed by
    // a stalled main thread (issue #1231 false timeouts).
    const t0 = performance.now();
    try {
      // The main thread resolves the language (it holds the project's
      // codegraph.json extension overrides) and sends it; fall back to detection
      // for older callers / safety.
      const language = msg.language ?? detectLanguage(filePath!, content);

      // Kernel deferred-decode fast path: ship the file's tables as flat
      // buffers and decode at the STORE boundary, so the main thread never
      // materializes per-node objects (nor pays their structured-clone cost —
      // buffer clone is a flat memcpy). Only when no applicable framework has
      // an extract() hook: those merge extra nodes/refs into the DECODED
      // result inside extractFromSource, so such files keep the decoded path.
      let result: ExtractionResult | undefined;
      const frameworksNeedDecode =
        frameworkNames && frameworkNames.length > 0
          ? getApplicableFrameworks(
              getAllFrameworkResolvers().filter((r) => frameworkNames.includes(r.name)),
              language
            ).some((fw) => !!fw.extract)
          : false;
      if (!frameworksNeedDecode) {
        const raw = tryKernelExtractRaw(filePath!, content!, language);
        if (raw) {
          result = {
            nodes: [],
            edges: [],
            unresolvedReferences: [],
            errors: raw.errors,
            durationMs: 0,
            kernelBuffers: raw.buffers,
            kernelCounts: raw.counts,
          };
        }
      }
      result ??= extractFromSource(filePath!, content!, language, frameworkNames);

      // Periodic parser reset to reclaim WASM heap memory
      const count = (parseCounts.get(language) ?? 0) + 1;
      parseCounts.set(language, count);
      if (count % PARSER_RESET_INTERVAL === 0) {
        resetParser(language);
      }

      parentPort!.postMessage({ type: 'parse-result', id, result, parseMs: performance.now() - t0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // WASM memory errors leave the module in a corrupted state — all
      // subsequent parses would also fail (cascading failures). Crash the
      // worker so the main thread spawns a fresh one with a clean heap.
      if (message.includes('memory access out of bounds') || message.includes('out of memory')) {
        process.exit(1);
      }

      parentPort!.postMessage({
        type: 'parse-result',
        id,
        parseMs: performance.now() - t0,
        result: {
          nodes: [],
          edges: [],
          unresolvedReferences: [],
          errors: [{ message: `Parse worker error: ${message}`, filePath: filePath!, severity: 'error', code: 'parse_error' }],
          durationMs: 0,
        } satisfies ExtractionResult,
      });
    }
  } else if (msg.type === 'shutdown') {
    parentPort!.postMessage({ type: 'shutdown-ack' });
  }
});
