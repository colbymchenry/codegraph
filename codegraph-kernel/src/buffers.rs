//! Flat buffer contract — the ONE boundary crossing per file.
//!
//! The kernel returns five Buffers: meta, nodes, edges, refs, arena. All rows
//! are fixed-width little-endian; every string is an (offset, len) pair into
//! the UTF-8 arena. `OFFSET == NONE (0xFFFF_FFFF)` means "field absent".
//!
//! THIS FILE AND `src/extraction/kernel/layout.ts` MUST MATCH BYTE FOR BYTE.
//! Any layout change bumps `KERNEL_ABI_VERSION` — the TS loader refuses a
//! version it doesn't know and falls back to the wasm path.
//!
//! Layout (v1):
//!
//! meta (36 bytes):
//!   0   u8   KERNEL_ABI_VERSION
//!   1   [3]  pad
//!   4   u32  node count
//!   8   u32  edge count
//!   12  u32  ref count
//!   16  u32  arena byte length
//!   20  u32  errors-JSON arena offset (NONE = no errors)
//!   24  u32  errors-JSON byte length
//!   28  f64  kernel-side wall duration (ms) — introspection only; the TS
//!            wrapper measures the ExtractionResult.durationMs it reports
//!
//! node row (96 bytes):
//!   0   u8   NodeKind index (NODE_KINDS order)
//!   1   u8   visibility (0 absent, 1 public, 2 private, 3 protected, 4 internal)
//!   2   u16  bool flags — bit pairs (present, value):
//!            0/1 isExported, 2/3 isAsync, 4/5 isStatic, 6/7 isAbstract
//!   4   u32  startLine (1-based)
//!   8   u32  endLine
//!   12  u32  startColumn (0-based)
//!   16  u32  endColumn
//!   20  str  name
//!   28  str  qualifiedName
//!   36  str  id (kernel-computed: "kind:hash32", or "file:<path>" for the file node)
//!   44  str  docstring
//!   52  str  signature
//!   60  str  decorators (NUL-joined list)
//!   68  str  typeParameters (NUL-joined list)
//!   76  str  returnType
//!   84  str  extraJson (escape hatch: JSON of any extra Node props)
//!   92  u32  metrics slot (reserved for Arc 3.2 per-node code metrics; 0)
//!
//! edge row (44 bytes):
//!   0   u32  source node row index (NONE → use sourceIdStr)
//!   4   u32  target node row index (NONE → use targetIdStr)
//!   8   u8   EdgeKind index (EDGE_KINDS order)
//!   9   u8   provenance (0 absent, 1 tree-sitter, 2 scip, 3 heuristic)
//!   10  u16  pad
//!   12  u32  line (NONE absent)
//!   16  u32  column (NONE absent)
//!   20  str  metadataJson
//!   28  str  sourceIdStr
//!   36  str  targetIdStr
//!
//! ref row (40 bytes):
//!   0   u32  fromNode row index (NONE → use fromNodeIdStr)
//!   4   u8   ReferenceKind (EDGE_KINDS index, or 200 = function_ref)
//!   5   u8   flags — bit 0: ref carries the extracting file's path (v2; the
//!            ruby/php visitNode hooks set `filePath: ctx.filePath` on their
//!            mixin/trait `implements` refs — decode re-attaches the decode
//!            call's own filePath, which is byte-identical)
//!   6   [2]  pad
//!   8   u32  line (1-based)
//!   12  u32  column (0-based)
//!   16  str  referenceName
//!   24  str  candidates (NUL-joined list)
//!   32  str  fromNodeIdStr

pub const KERNEL_ABI_VERSION: u8 = 2;
pub const NONE: u32 = 0xFFFF_FFFF;

pub const META_SIZE: usize = 36;
pub const NODE_ROW_SIZE: usize = 96;
pub const EDGE_ROW_SIZE: usize = 44;
pub const REF_ROW_SIZE: usize = 40;

/// Mirror of NODE_KINDS in src/types.ts — order is the wire contract.
pub const NODE_KINDS: [&str; 22] = [
    "file",
    "module",
    "class",
    "struct",
    "interface",
    "trait",
    "protocol",
    "function",
    "method",
    "property",
    "field",
    "variable",
    "constant",
    "enum",
    "enum_member",
    "type_alias",
    "namespace",
    "parameter",
    "import",
    "export",
    "route",
    "component",
];

/// Mirror of EDGE_KINDS in src/types.ts — order is the wire contract.
pub const EDGE_KINDS: [&str; 12] = [
    "contains",
    "calls",
    "imports",
    "exports",
    "extends",
    "implements",
    "references",
    "type_of",
    "returns",
    "instantiates",
    "overrides",
    "decorates",
];

/// ReferenceKind code for the internal-only `function_ref` (#756).
pub const FUNCTION_REF_CODE: u8 = 200;

/// Ref-row flag bit 0: the ref carries `filePath` = the extracted file.
pub const REF_FLAG_FILE_PATH: u8 = 1;

pub fn node_kind_index(kind: &str) -> Option<u8> {
    NODE_KINDS.iter().position(|k| *k == kind).map(|i| i as u8)
}

pub fn edge_kind_index(kind: &str) -> Option<u8> {
    EDGE_KINDS.iter().position(|k| *k == kind).map(|i| i as u8)
}

/// (offset, len) arena reference. `NONE_STR` encodes an absent field.
pub type StrRef = (u32, u32);
pub const NONE_STR: StrRef = (NONE, 0);

/// UTF-8 string arena. Strings are appended verbatim; no dedup (per-file
/// buffers are transient and small — intern later if profiling says so).
#[derive(Default)]
pub struct Arena {
    buf: Vec<u8>,
}

impl Arena {
    pub fn put(&mut self, s: &str) -> StrRef {
        let off = self.buf.len() as u32;
        self.buf.extend_from_slice(s.as_bytes());
        (off, s.len() as u32)
    }

    /// Not used by the seed emitter yet — R2 (docstring/signature/etc.). Kept
    /// so the arena API is complete alongside the layout it feeds.
    #[allow(dead_code)]
    pub fn put_opt(&mut self, s: Option<&str>) -> StrRef {
        match s {
            Some(s) => self.put(s),
            None => NONE_STR,
        }
    }

    /// NUL-joined list; absent when the list is empty. (R2 surface: decorators,
    /// typeParameters, candidates.)
    #[allow(dead_code)]
    pub fn put_list(&mut self, items: &[String]) -> StrRef {
        if items.is_empty() {
            return NONE_STR;
        }
        let joined = items.join("\0");
        self.put(&joined)
    }

    pub fn len(&self) -> u32 {
        self.buf.len() as u32
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}

/// Tri-state booleans packed as (present, value) bit pairs.
#[derive(Default, Clone, Copy)]
pub struct BoolFlags(pub u16);

impl BoolFlags {
    pub fn set(&mut self, pair: u16, value: bool) {
        self.0 |= 1 << (pair * 2);
        if value {
            self.0 |= 1 << (pair * 2 + 1);
        }
    }
}

pub const FLAG_IS_EXPORTED: u16 = 0;
#[allow(dead_code)] // R2 surface — part of the v1 wire contract
pub const FLAG_IS_ASYNC: u16 = 1;
#[allow(dead_code)] // R2 surface — part of the v1 wire contract
pub const FLAG_IS_STATIC: u16 = 2;
#[allow(dead_code)] // R2 surface — part of the v1 wire contract
pub const FLAG_IS_ABSTRACT: u16 = 3;

pub struct NodeRow {
    pub kind: u8,
    pub visibility: u8,
    pub flags: BoolFlags,
    pub start_line: u32,
    pub end_line: u32,
    pub start_column: u32,
    pub end_column: u32,
    pub name: StrRef,
    pub qualified_name: StrRef,
    pub id: StrRef,
    pub docstring: StrRef,
    pub signature: StrRef,
    pub decorators: StrRef,
    pub type_parameters: StrRef,
    pub return_type: StrRef,
    pub extra_json: StrRef,
}

pub struct EdgeRow {
    pub source_idx: u32,
    pub target_idx: u32,
    pub kind: u8,
    pub provenance: u8,
    pub line: u32,
    pub column: u32,
    pub metadata_json: StrRef,
    pub source_id_str: StrRef,
    pub target_id_str: StrRef,
}

pub struct RefRow {
    pub from_idx: u32,
    pub kind: u8,
    pub line: u32,
    pub column: u32,
    pub reference_name: StrRef,
    pub candidates: StrRef,
    pub from_id_str: StrRef,
}

fn push_str_ref(buf: &mut Vec<u8>, r: StrRef) {
    buf.extend_from_slice(&r.0.to_le_bytes());
    buf.extend_from_slice(&r.1.to_le_bytes());
}

pub struct Tables {
    pub nodes: Vec<u8>,
    pub edges: Vec<u8>,
    pub refs: Vec<u8>,
    pub node_count: u32,
    pub edge_count: u32,
    pub ref_count: u32,
}

impl Default for Tables {
    fn default() -> Self {
        Tables {
            nodes: Vec::with_capacity(NODE_ROW_SIZE * 64),
            edges: Vec::with_capacity(EDGE_ROW_SIZE * 64),
            refs: Vec::with_capacity(REF_ROW_SIZE * 64),
            node_count: 0,
            edge_count: 0,
            ref_count: 0,
        }
    }
}

impl Tables {
    pub fn push_node(&mut self, r: &NodeRow) -> u32 {
        let buf = &mut self.nodes;
        buf.push(r.kind);
        buf.push(r.visibility);
        buf.extend_from_slice(&r.flags.0.to_le_bytes());
        buf.extend_from_slice(&r.start_line.to_le_bytes());
        buf.extend_from_slice(&r.end_line.to_le_bytes());
        buf.extend_from_slice(&r.start_column.to_le_bytes());
        buf.extend_from_slice(&r.end_column.to_le_bytes());
        push_str_ref(buf, r.name);
        push_str_ref(buf, r.qualified_name);
        push_str_ref(buf, r.id);
        push_str_ref(buf, r.docstring);
        push_str_ref(buf, r.signature);
        push_str_ref(buf, r.decorators);
        push_str_ref(buf, r.type_parameters);
        push_str_ref(buf, r.return_type);
        push_str_ref(buf, r.extra_json);
        buf.extend_from_slice(&0u32.to_le_bytes()); // metrics slot (Arc 3.2)
        let idx = self.node_count;
        self.node_count += 1;
        idx
    }

    pub fn push_edge(&mut self, r: &EdgeRow) {
        let buf = &mut self.edges;
        buf.extend_from_slice(&r.source_idx.to_le_bytes());
        buf.extend_from_slice(&r.target_idx.to_le_bytes());
        buf.push(r.kind);
        buf.push(r.provenance);
        buf.extend_from_slice(&0u16.to_le_bytes()); // pad
        buf.extend_from_slice(&r.line.to_le_bytes());
        buf.extend_from_slice(&r.column.to_le_bytes());
        push_str_ref(buf, r.metadata_json);
        push_str_ref(buf, r.source_id_str);
        push_str_ref(buf, r.target_id_str);
        self.edge_count += 1;
    }

    pub fn push_ref(&mut self, r: &RefRow) {
        self.push_ref_flagged(r, 0);
    }

    pub fn push_ref_flagged(&mut self, r: &RefRow, flags: u8) {
        let buf = &mut self.refs;
        buf.extend_from_slice(&r.from_idx.to_le_bytes());
        buf.push(r.kind);
        buf.push(flags);
        buf.extend_from_slice(&[0u8; 2]); // pad
        buf.extend_from_slice(&r.line.to_le_bytes());
        buf.extend_from_slice(&r.column.to_le_bytes());
        push_str_ref(buf, r.reference_name);
        push_str_ref(buf, r.candidates);
        push_str_ref(buf, r.from_id_str);
        self.ref_count += 1;
    }
}

/// One file's encoded tables, ready to hand across the JS boundary.
pub struct EmitOut {
    pub meta: Vec<u8>,
    pub nodes: Vec<u8>,
    pub edges: Vec<u8>,
    pub refs: Vec<u8>,
    pub arena: Vec<u8>,
}

pub fn build_meta(t: &Tables, arena_len: u32, errors_json: StrRef, duration_ms: f64) -> Vec<u8> {
    let mut m = Vec::with_capacity(META_SIZE);
    m.push(KERNEL_ABI_VERSION);
    m.extend_from_slice(&[0u8; 3]);
    m.extend_from_slice(&t.node_count.to_le_bytes());
    m.extend_from_slice(&t.edge_count.to_le_bytes());
    m.extend_from_slice(&t.ref_count.to_le_bytes());
    m.extend_from_slice(&arena_len.to_le_bytes());
    m.extend_from_slice(&errors_json.0.to_le_bytes());
    m.extend_from_slice(&errors_json.1.to_le_bytes());
    m.extend_from_slice(&duration_ms.to_le_bytes());
    debug_assert_eq!(m.len(), META_SIZE);
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_sizes_match_constants() {
        let mut t = Tables::default();
        let mut a = Arena::default();
        let name = a.put("x");
        t.push_node(&NodeRow {
            kind: 0,
            visibility: 0,
            flags: BoolFlags::default(),
            start_line: 1,
            end_line: 1,
            start_column: 0,
            end_column: 0,
            name,
            qualified_name: name,
            id: name,
            docstring: NONE_STR,
            signature: NONE_STR,
            decorators: NONE_STR,
            type_parameters: NONE_STR,
            return_type: NONE_STR,
            extra_json: NONE_STR,
        });
        assert_eq!(t.nodes.len(), NODE_ROW_SIZE);
        t.push_edge(&EdgeRow {
            source_idx: 0,
            target_idx: 0,
            kind: 0,
            provenance: 0,
            line: NONE,
            column: NONE,
            metadata_json: NONE_STR,
            source_id_str: NONE_STR,
            target_id_str: NONE_STR,
        });
        assert_eq!(t.edges.len(), EDGE_ROW_SIZE);
        t.push_ref(&RefRow {
            from_idx: 0,
            kind: 1,
            line: 1,
            column: 0,
            reference_name: name,
            candidates: NONE_STR,
            from_id_str: NONE_STR,
        });
        assert_eq!(t.refs.len(), REF_ROW_SIZE);
        let meta = build_meta(&t, a.len(), NONE_STR, 0.0);
        assert_eq!(meta.len(), META_SIZE);
    }
}
