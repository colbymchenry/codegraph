/**
 * Kernel routing — which languages go through the native kernel, and the
 * single entry point the extraction path calls.
 *
 * Routing policy is deliberately TS-side and per-language (migration plan §2):
 * a language routes to the kernel only after its equivalence gate passes;
 * everything else stays on the wasm path forever if need be. Rollback per
 * language = removing it from DEFAULT_ROUTED (or CODEGRAPH_KERNEL=0 for all).
 *
 * Routing status: TypeScript/TSX/JavaScript/JSX are default-routed (R3 gate
 * passed 2026-07-16 — full-index dumps byte-identical on express/excalidraw/
 * vscode, control repo unchanged; see the migration plan §4a). Override with
 *   CODEGRAPH_KERNEL_LANGS=<langs|all>  (replaces the default set), or
 *   CODEGRAPH_KERNEL=0                  (kill switch, everything → wasm).
 */

import type { ExtractionResult, Language } from '../../types';
import { EXTRACTORS } from '../languages';
import { getKernel, kernelSupports } from './loader';
import { decodeExtractBuffers } from './decode';
import {
  KERNEL_ABI_VERSION as LAYOUT_ABI,
  META as LAYOUT_META,
  NONE as LAYOUT_NONE,
} from './layout';

export { getKernel, kernelSupports, resetKernelForTests } from './loader';
export { decodeExtractBuffers } from './decode';

/**
 * Languages routed to the kernel by default (gate-passed only — see the
 * per-language tracker in docs/design/rust-kernel-migration-plan.md §4).
 * Per-file safety valve regardless of routing: a file whose parse tree
 * contains ERRORS defers to the wasm extractor (error recovery differs
 * between UTF-8 and UTF-16 parsing — wasm's recovery is canonical).
 */
const DEFAULT_ROUTED: ReadonlySet<Language> = new Set<Language>([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'java',
  'python',
  'go',
  // R7a (2026-07-17): parity swept 0-diff on redis/git/fmt/protobuf/ALS
  // (2,389 files compared) + full-init dump-diffs byte-identical; erroring
  // files defer per-file to wasm (routine for macro-heavy C/C++ — see
  // scripts/kernel-parity.mjs --max-deferral).
  'c',
  'cpp',
  // R7b (2026-07-20): parity swept 0-diff on ripgrep/tokio/rust-analyzer
  // (2,108 files byte-parity) + full-init dump-diffs byte-identical. Rust
  // deferral is ~0% on normal repos; token-macro-table sources (rust-analyzer's
  // parser crates, 18%) error on BOTH arms — grammar-inherent, not a walker
  // signal.
  'rust',
]);

/**
 * Per-language TS post-pass over the decoded result — the escape hatch for
 * logic `.scm` queries can't express (macro salvage, dialect sniffing,
 * wrapper-based component recognition). Runs synchronously after decode,
 * before the framework extract() hooks the caller applies. Keep these SMALL:
 * anything heavy belongs in the Rust emitter.
 */
export type KernelPostPass = (result: ExtractionResult, source: string) => void;
const POST_PASSES: Partial<Record<Language, KernelPostPass>> = {
  // (none yet — R2+)
};

/**
 * The preParse hoist (checklist §arch-1): languages with an offset-preserving
 * `preParse` hook (c/cpp macro blanking, csharp #237, metal #1121, cuda #1172)
 * apply it HERE, before the kernel call, so both arms parse identical blanked
 * bytes and none of the blanking logic needs a Rust port. The wasm fallback
 * path is untouched — TreeSitterExtractor applies the same hook itself on the
 * RAW source it receives, so a kernel error/defer still extracts identically.
 * Every blank is an equal-length-space replacement, so offsets, lines, and
 * columns survive; `filePath` rides along for the extension-gated dialect
 * blanks (`.metal` attributes; `.cu`/`.cuh` + content-gated CUDA).
 */
function preParsedSource(filePath: string, source: string, language: Language): string {
  const pre = EXTRACTORS[language]?.preParse;
  return pre ? pre(source, filePath) : source;
}

function isRouted(language: Language): boolean {
  const env = process.env.CODEGRAPH_KERNEL_LANGS;
  if (env === undefined || env === '') return DEFAULT_ROUTED.has(language);
  if (env === 'all') return true;
  return env
    .split(',')
    .map((s) => s.trim())
    .includes(language);
}

/** True when `language` would be extracted by the kernel right now. */
export function kernelRoutes(language: Language): boolean {
  return isRouted(language) && kernelSupports(language);
}

/** Warned-once registry so a broken language logs a single line, not one per file. */
const warned = new Set<string>();

/**
 * One-slot defer memo. A file the kernel defers (parse errors → wasm) used to
 * pay the full pipeline again at every seam: the worker's raw try blanked +
 * native-parsed it, extractFromSource's kernel try blanked + native-parsed it
 * AGAIN, and the wasm extractor then re-applied preParse a third time. On a
 * high-deferral tree (the Linux kernel defers ~79% of files) that waste
 * dominated the arm's parse phase. The slot remembers the LAST deferred
 * (file, source, language) so (a) a repeat kernel attempt for the same file
 * short-circuits to null, and (b) the wasm fallback can reuse the
 * already-blanked source instead of re-running preParse. Source is matched by
 * string identity — the worker passes the same string through every seam.
 */
let deferSlot: { filePath: string; source: string; language: Language; pre: string } | null = null;

/** The hoisted preParse output for a just-deferred file, if it matches. */
export function takeDeferredPreParse(
  filePath: string,
  source: string,
  language: Language
): string | null {
  if (
    deferSlot &&
    deferSlot.filePath === filePath &&
    deferSlot.source === source &&
    deferSlot.language === language
  ) {
    return deferSlot.pre;
  }
  return null;
}

/** The raw table buffers + the cheap facts the orchestrator needs pre-decode. */
export interface KernelRawResult {
  buffers: NonNullable<ExtractionResult['kernelBuffers']>;
  counts: { nodes: number; edges: number; refs: number };
  errors: ExtractionResult['errors'];
}

/**
 * Extract via the kernel WITHOUT decoding — the bulk-index fast path. The
 * tables ride to the store boundary as buffers (decoded on the store worker),
 * so the main thread never materializes per-node objects. Returns null under
 * exactly the conditions tryKernelExtract does, PLUS when the language has a
 * registered post() pass (post passes operate on decoded results, so those
 * languages keep the decoded path).
 */
export function tryKernelExtractRaw(
  filePath: string,
  source: string,
  language: Language
): KernelRawResult | null {
  if (!kernelRoutes(language) || POST_PASSES[language]) return null;
  const kernel = getKernel();
  if (!kernel) return null;
  if (takeDeferredPreParse(filePath, source, language) !== null) return null; // already deferred
  const pre = preParsedSource(filePath, source, language);
  try {
    const buffers = kernel.extractFile(filePath, pre, language);
    const meta = buffers.meta;
    if (meta.readUInt8(LAYOUT_META.version) !== LAYOUT_ABI) {
      throw new Error(`kernel buffer ABI ${meta.readUInt8(0)} != expected ${LAYOUT_ABI}`);
    }
    const counts = {
      nodes: meta.readUInt32LE(LAYOUT_META.nodeCount),
      edges: meta.readUInt32LE(LAYOUT_META.edgeCount),
      refs: meta.readUInt32LE(LAYOUT_META.refCount),
    };
    let errors: ExtractionResult['errors'] = [];
    const errorsOff = meta.readUInt32LE(LAYOUT_META.errorsOff);
    if (errorsOff !== LAYOUT_NONE) {
      const errorsLen = meta.readUInt32LE(LAYOUT_META.errorsLen);
      errors = JSON.parse(
        buffers.arena.toString('utf8', errorsOff, errorsOff + errorsLen)
      ) as ExtractionResult['errors'];
    }
    return { buffers, counts, errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('defer:')) {
      deferSlot = { filePath, source, language, pre };
      return null;
    }
    if (!warned.has(language)) {
      warned.add(language);
      process.stderr.write(
        `[codegraph-kernel] ${language} extraction failed (${message}) — falling back to the wasm path\n`
      );
    }
    return null;
  }
}

/**
 * Decode a buffer-carrying result (see ExtractionResult.kernelBuffers) into a
 * plain, fully-materialized ExtractionResult — the fallback for store paths
 * that need objects (main-thread store, tests).
 */
export function materializeKernelResult(
  result: ExtractionResult,
  filePath: string,
  language: Language
): ExtractionResult {
  if (!result.kernelBuffers) return result;
  const b = result.kernelBuffers;
  const asBuf = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
  const decoded = decodeExtractBuffers(
    { meta: asBuf(b.meta), nodes: asBuf(b.nodes), edges: asBuf(b.edges), refs: asBuf(b.refs), arena: asBuf(b.arena) },
    filePath,
    language
  );
  decoded.durationMs = result.durationMs;
  return decoded;
}

/**
 * Extract via the native kernel. Returns null when the kernel doesn't apply
 * (not routed / not available / kill switch) — the caller falls back to the
 * wasm TreeSitterExtractor. A kernel ERROR on a routed file also returns
 * null: per-file fallback keeps indexing correct while a kernel bug costs
 * only that file's speedup.
 */
export function tryKernelExtract(
  filePath: string,
  source: string,
  language: Language
): ExtractionResult | null {
  if (!kernelRoutes(language)) return null;
  const kernel = getKernel();
  if (!kernel) return null;
  if (takeDeferredPreParse(filePath, source, language) !== null) return null; // already deferred
  const t0 = Date.now();
  const pre = preParsedSource(filePath, source, language);
  try {
    const buffers = kernel.extractFile(filePath, pre, language);
    const result = decodeExtractBuffers(buffers, filePath, language);
    POST_PASSES[language]?.(result, source);
    result.durationMs = Date.now() - t0;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `defer:` is the kernel's expected-routing signal (files with parse
    // errors take the wasm path — its error RECOVERY is the canonical one;
    // recovery differs between UTF-8 and UTF-16 parsing). Silent by design.
    if (message.includes('defer:')) {
      deferSlot = { filePath, source, language, pre };
      return null;
    }
    if (!warned.has(language)) {
      warned.add(language);
      process.stderr.write(
        `[codegraph-kernel] ${language} extraction failed (${message}) — falling back to the wasm path\n`
      );
    }
    return null;
  }
}
