/**
 * Native-kernel loader — finds, loads, and contract-verifies the
 * codegraph-kernel .node addon.
 *
 * The kernel is OPTIONAL everywhere. Every failure mode here (no binary for
 * this platform, dlopen error, ABI/kind-table mismatch) resolves to `null`
 * and the extraction path silently keeps using the wasm pipeline — a missing
 * or stale kernel must never break indexing, only skip the speedup. Set
 * CODEGRAPH_KERNEL_DEBUG=1 to see why a kernel didn't load.
 *
 * Kill switch: CODEGRAPH_KERNEL=0 disables the kernel entirely (checked per
 * call so tests and embedders can flip it at runtime).
 *
 * Search order:
 *   1. CODEGRAPH_KERNEL_PATH — explicit .node path (dev/testing override)
 *   2. <up3>/kernel/codegraph-kernel.node — the release bundle layout
 *      (lib/dist/** next to lib/kernel/; see scripts/build-bundle.sh)
 *   3. <up3>/codegraph-kernel/prebuilds/<platform>-<arch>/codegraph-kernel.node
 *      — from-source runs and tests (staged by scripts/build-kernel.sh)
 *
 * "up3" = three directories above this file, which is the package root both
 * from src/extraction/kernel/ and from dist/extraction/kernel/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { NODE_KINDS, EDGE_KINDS } from '../../types';
import { KERNEL_ABI_VERSION } from './layout';

/** Raw buffer tables for one file — see layout.ts for the byte layout. */
export interface KernelBuffers {
  meta: Buffer;
  nodes: Buffer;
  edges: Buffer;
  refs: Buffer;
  arena: Buffer;
}

export interface KernelContractInfo {
  abiVersion: number;
  kernelVersion: string;
  nodeKinds: string[];
  edgeKinds: string[];
  languages: string[];
}

export interface KernelGrammarInfo {
  abiVersion: number;
  nodeKindCount: number;
  fieldCount: number;
  nodeKinds: string[];
  fieldNames: string[];
}

/** Input to the cFnPtr extraction sweep: one file's raw text + its struct
 *  node extents (`endLine ?? startLine` applied by the caller). */
export interface CfnptrFileIn {
  text: string;
  structs: { id: string; startLine: number; endLine: number }[];
}

/** Per-file facts from the native cFnPtr extraction sweep — mirror of the
 *  Rust `CfnptrFacts` (see codegraph-kernel/src/cfnptr.rs); semantics match
 *  the JS sweep in src/resolution/c-fnptr-synthesizer.ts. */
export interface CfnptrFactsOut {
  fnPtrTypedefs: string[];
  fnTypeTypedefs: string[];
  structs: { id: string; parsed: boolean; fields: { name: string; index: number; ptr: boolean; type: string }[] }[];
  inlinePtr: boolean;
  inlineTypes: string[];
  inlineTags: string[];
  initTokens: string[];
  arrayElems: string[];
  aliasNames: string[];
  dPairs: string[];
  dispatchFields: string[];
  arrayDispatchNames: string[];
  includes: string[];
}

export interface KernelModule {
  extractFile(filePath: string, content: string, language: string): KernelBuffers;
  contractInfo(): KernelContractInfo;
  grammarInfo(language: string): KernelGrammarInfo | null;
  /** Batched cFnPtr extraction sweep (task #5 step 2). OPTIONAL: absent on
   *  older binaries — callers feature-detect and keep their JS path. */
  cfnptrScanFiles?(files: CfnptrFileIn[]): CfnptrFactsOut[];
  /** Native `stripCommentsForRegex(text, 'c')` — differential-oracle hook. */
  cfnptrStripC?(text: string): string;
}

const debugEnabled = () => process.env.CODEGRAPH_KERNEL_DEBUG === '1';
function debug(msg: string): void {
  if (debugEnabled()) process.stderr.write(`[codegraph-kernel] ${msg}\n`);
}

/** Languages the loaded binary supports (contract-verified). Empty when no kernel. */
let kernelLanguages: ReadonlySet<string> = new Set();
/** undefined = not attempted yet; null = attempted and unavailable. */
let cached: KernelModule | null | undefined;

function candidatePaths(): string[] {
  const candidates: string[] = [];
  if (process.env.CODEGRAPH_KERNEL_PATH) candidates.push(process.env.CODEGRAPH_KERNEL_PATH);
  const packageRoot = path.resolve(__dirname, '..', '..', '..');
  candidates.push(path.join(packageRoot, 'kernel', 'codegraph-kernel.node'));
  candidates.push(
    path.join(
      packageRoot,
      'codegraph-kernel',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'codegraph-kernel.node'
    )
  );
  return candidates;
}

/**
 * Verify the binary speaks our wire contract: same ABI version and byte-equal
 * NodeKind/EdgeKind tables (kinds cross the boundary as indexes into these).
 */
function verifyContract(mod: KernelModule, from: string): boolean {
  const info = mod.contractInfo();
  if (info.abiVersion !== KERNEL_ABI_VERSION) {
    debug(`${from}: ABI ${info.abiVersion} != expected ${KERNEL_ABI_VERSION} — ignoring kernel`);
    return false;
  }
  const sameTable = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  if (!sameTable(info.nodeKinds, NODE_KINDS) || !sameTable(info.edgeKinds, EDGE_KINDS)) {
    debug(`${from}: NodeKind/EdgeKind tables differ from src/types.ts — ignoring kernel`);
    return false;
  }
  return true;
}

/**
 * Load (once per process) and return the kernel module, or null when
 * unavailable. The kill switch is NOT checked here — callers route through
 * `kernelAvailable()` / `tryKernelExtract()` which check it per call.
 */
export function getKernel(): KernelModule | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const candidate of candidatePaths()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      // createRequire: works identically from CJS output and future ESM.
      const req = createRequire(__filename);
      const mod = req(candidate) as KernelModule;
      if (typeof mod.extractFile !== 'function' || typeof mod.contractInfo !== 'function') {
        debug(`${candidate}: missing expected exports — ignoring`);
        continue;
      }
      if (!verifyContract(mod, candidate)) continue;
      kernelLanguages = new Set(mod.contractInfo().languages);
      debug(`loaded ${candidate} (languages: ${[...kernelLanguages].join(', ')})`);
      cached = mod;
      break;
    } catch (err) {
      debug(`${candidate}: failed to load — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return cached;
}

/** True when the kill switch is off, a verified binary is loaded, and it supports `language`. */
export function kernelSupports(language: string): boolean {
  if (process.env.CODEGRAPH_KERNEL === '0') return false;
  return getKernel() !== null && kernelLanguages.has(language);
}

/** Test hook: forget the loaded module so a changed env is re-evaluated. */
export function resetKernelForTests(): void {
  cached = undefined;
  kernelLanguages = new Set();
}
