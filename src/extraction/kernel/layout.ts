/**
 * Native-kernel buffer layout — TS mirror of codegraph-kernel/src/buffers.rs.
 *
 * The kernel returns five Buffers per file: meta, nodes, edges, refs, arena.
 * Rows are fixed-width little-endian; strings are (offset, len) pairs into
 * the UTF-8 arena; `offset === NONE` means "field absent".
 *
 * THIS FILE AND buffers.rs MUST MATCH BYTE FOR BYTE. Any layout change bumps
 * KERNEL_ABI_VERSION on both sides — the loader refuses a version it doesn't
 * know and the extraction path falls back to wasm.
 *
 * NodeKind / EdgeKind / provenance / visibility cross the boundary as indexes
 * into NODE_KINDS / EDGE_KINDS (src/types.ts) and the small tables below, so
 * those array orders are part of the contract (append, never reorder). The
 * loader additionally verifies the kernel's own kind tables against
 * NODE_KINDS/EDGE_KINDS at load time, so a stale .node degrades to the wasm
 * path instead of mis-decoding.
 */

export const KERNEL_ABI_VERSION = 2;

/** Sentinel for "absent" in u32 slots and string-ref offsets. */
export const NONE = 0xffffffff;

export const META_SIZE = 36;
export const NODE_ROW_SIZE = 96;
export const EDGE_ROW_SIZE = 44;
export const REF_ROW_SIZE = 40;

/** meta byte offsets */
export const META = {
  version: 0, // u8
  nodeCount: 4, // u32
  edgeCount: 8, // u32
  refCount: 12, // u32
  arenaLen: 16, // u32
  errorsOff: 20, // u32 (NONE = no errors)
  errorsLen: 24, // u32
  durationMs: 28, // f64 (kernel-side wall; introspection only)
} as const;

/** node row byte offsets */
export const NODE = {
  kind: 0, // u8 — NODE_KINDS index
  visibility: 1, // u8 — VISIBILITIES index (0 = absent)
  flags: 2, // u16 — (present, value) bit pairs, see FLAG
  startLine: 4, // u32
  endLine: 8, // u32
  startColumn: 12, // u32
  endColumn: 16, // u32
  name: 20, // str
  qualifiedName: 28, // str
  id: 36, // str — kernel-computed node id
  docstring: 44, // str
  signature: 52, // str
  decorators: 60, // str — NUL-joined list
  typeParameters: 68, // str — NUL-joined list
  returnType: 76, // str
  extraJson: 84, // str — JSON of any extra Node props (escape hatch)
  metrics: 92, // u32 — reserved (Arc 3.2 per-node code metrics)
} as const;

/** edge row byte offsets */
export const EDGE = {
  sourceIdx: 0, // u32 (NONE → sourceIdStr)
  targetIdx: 4, // u32 (NONE → targetIdStr)
  kind: 8, // u8 — EDGE_KINDS index
  provenance: 9, // u8 — PROVENANCES index (0 = absent)
  line: 12, // u32 (NONE = absent)
  column: 16, // u32 (NONE = absent)
  metadataJson: 20, // str
  sourceIdStr: 28, // str
  targetIdStr: 36, // str
} as const;

/** ref row byte offsets */
export const REF = {
  fromIdx: 0, // u32 (NONE → fromIdStr)
  kind: 4, // u8 — EDGE_KINDS index, or FUNCTION_REF_CODE
  flags: 5, // u8 — REF_FLAGS bits (v2)
  line: 8, // u32
  column: 12, // u32
  referenceName: 16, // str
  candidates: 24, // str — NUL-joined list
  fromIdStr: 32, // str
} as const;

/** ReferenceKind wire code for the internal-only `function_ref` (#756). */
export const FUNCTION_REF_CODE = 200;

/**
 * Ref-row flag bits (v2). FILE_PATH: the ref carries `filePath` = the
 * extracted file — the ruby/php visitNode hooks set `filePath: ctx.filePath`
 * on their mixin/trait `implements` refs (unlike every other extraction ref,
 * which the store denormalizes); decode re-attaches its own filePath
 * parameter, which is byte-identical.
 */
export const REF_FLAG_FILE_PATH = 1;

/** Node bool-flag bit pairs: bit(2n) = present, bit(2n+1) = value. */
export const FLAG = {
  isExported: 0,
  isAsync: 1,
  isStatic: 2,
  isAbstract: 3,
} as const;

/** visibility byte values (0 = absent). */
export const VISIBILITIES = [undefined, 'public', 'private', 'protected', 'internal'] as const;

/** provenance byte values (0 = absent). */
export const PROVENANCES = [undefined, 'tree-sitter', 'scip', 'heuristic'] as const;
