//! codegraph-kernel — native extraction kernel (napi-rs).
//!
//! Replaces ONLY the parse+extract walk inside the parse workers, behind the
//! existing `ExtractionResult` contract. Input `(filePath, content, language)`
//! per file; output flat typed buffers — one boundary crossing per file.
//! Everything downstream (resolution, synthesis, frameworks, MCP) is
//! untouched and consumes the decoded result exactly as before.
//!
//! Calls are synchronous by design: the existing `ParseWorkerPool` workers
//! already parallelize per-file, so each worker thread drives its own kernel
//! call (do NOT rebuild the pool on the Rust side — see the migration plan §3).
//!
//! Per-language extraction lives in a dedicated walker module (tsjs/ for
//! typescript/tsx/javascript/jsx) that mirrors the TS extractor for behavioral
//! parity — verified by scripts/kernel-parity.mjs and the §5 gate.

#![deny(clippy::all)]

mod buffers;
mod ccpp;
mod cfnptr;
mod docstring;
mod ids;
mod go;
mod java;
mod langs;
mod rustlang;
mod textutil;
mod python;
mod tsjs;

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// The five flat tables for one file. See buffers.rs for the byte layout;
/// `src/extraction/kernel/layout.ts` is the TS mirror.
#[napi(object)]
pub struct ExtractBuffers {
    pub meta: Buffer,
    pub nodes: Buffer,
    pub edges: Buffer,
    pub refs: Buffer,
    pub arena: Buffer,
}

/// Wire-contract description — the TS loader verifies this against
/// src/types.ts before routing anything to the kernel, so an out-of-date
/// `.node` degrades to the wasm path instead of mis-decoding.
#[napi(object)]
pub struct ContractInfo {
    pub abi_version: u32,
    pub kernel_version: String,
    pub node_kinds: Vec<String>,
    pub edge_kinds: Vec<String>,
    /// Languages this binary can extract (routing is still TS-side policy).
    pub languages: Vec<String>,
}

/// Grammar identity for the grammar-source-parity gate: the wasm grammar and
/// the native grammar must expose identical node-kind/field tables, or
/// kernel-vs-fallback routing would be non-deterministic.
#[napi(object)]
pub struct GrammarInfo {
    pub abi_version: u32,
    pub node_kind_count: u32,
    pub field_count: u32,
    pub node_kinds: Vec<String>,
    pub field_names: Vec<String>,
}

#[napi]
pub fn contract_info() -> ContractInfo {
    ContractInfo {
        abi_version: buffers::KERNEL_ABI_VERSION as u32,
        kernel_version: env!("CARGO_PKG_VERSION").to_string(),
        node_kinds: buffers::NODE_KINDS.iter().map(|s| s.to_string()).collect(),
        edge_kinds: buffers::EDGE_KINDS.iter().map(|s| s.to_string()).collect(),
        languages: langs::LANGUAGES.iter().map(|s| s.to_string()).collect(),
    }
}

#[napi]
pub fn grammar_info(language: String) -> Option<GrammarInfo> {
    let lang = langs::grammar_for(&language)?;
    let node_kind_count = lang.node_kind_count();
    let field_count = lang.field_count();
    let node_kinds = (0..node_kind_count)
        .map(|i| lang.node_kind_for_id(i as u16).unwrap_or("").to_string())
        .collect();
    // Field ids are 1-based in tree-sitter.
    let field_names = (1..=field_count)
        .map(|i| lang.field_name_for_id(i as u16).unwrap_or("").to_string())
        .collect();
    Some(GrammarInfo {
        abi_version: lang.abi_version() as u32,
        node_kind_count: node_kind_count as u32,
        field_count: field_count as u32,
        node_kinds,
        field_names,
    })
}

/// One struct node's extent for the cFnPtr sweep (mirror of the TS caller's
/// `{ id, startLine, endLine }`, with `endLine ?? startLine` applied TS-side).
#[napi(object)]
pub struct CfnptrStructIn {
    pub id: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[napi(object)]
pub struct CfnptrFileIn {
    /// RAW file text, exactly as the resolver's readFile returned it.
    pub text: String,
    pub structs: Vec<CfnptrStructIn>,
}

#[napi(object)]
pub struct CfnptrField {
    pub name: String,
    pub index: u32,
    pub ptr: bool,
    #[napi(js_name = "type")]
    pub ty: String,
}

#[napi(object)]
pub struct CfnptrStructOut {
    pub id: String,
    pub parsed: bool,
    pub fields: Vec<CfnptrField>,
}

/// The cFnPtr extraction-sweep facts for one file — see cfnptr.rs (and the
/// TS synthesizer's `FileFacts`) for field semantics.
#[napi(object)]
pub struct CfnptrFacts {
    pub fn_ptr_typedefs: Vec<String>,
    pub fn_type_typedefs: Vec<String>,
    pub structs: Vec<CfnptrStructOut>,
    pub inline_ptr: bool,
    pub inline_types: Vec<String>,
    pub inline_tags: Vec<String>,
    pub init_tokens: Vec<String>,
    pub array_elems: Vec<String>,
    pub alias_names: Vec<String>,
    pub d_pairs: Vec<String>,
    pub dispatch_fields: Vec<String>,
    pub array_dispatch_names: Vec<String>,
    pub includes: Vec<String>,
}

/// Batched cFnPtr extraction sweep (task #5 step 2): one call scans a batch
/// of files and returns their collected facts, amortizing the NAPI boundary.
/// Feature-detected by the TS loader — absent on older binaries, where the
/// synthesizer keeps its JS sweep.
#[napi]
pub fn cfnptr_scan_files(files: Vec<CfnptrFileIn>) -> Vec<CfnptrFacts> {
    files
        .into_iter()
        .map(|f| {
            let structs: Vec<cfnptr::StructExtent> = f
                .structs
                .into_iter()
                .map(|s| cfnptr::StructExtent { id: s.id, start_line: s.start_line, end_line: s.end_line })
                .collect();
            let facts = cfnptr::scan_file(&f.text, &structs);
            CfnptrFacts {
                fn_ptr_typedefs: facts.fn_ptr_typedefs,
                fn_type_typedefs: facts.fn_type_typedefs,
                structs: facts
                    .structs
                    .into_iter()
                    .map(|s| CfnptrStructOut {
                        id: s.id,
                        parsed: s.parsed,
                        fields: s
                            .fields
                            .into_iter()
                            .map(|fl| CfnptrField { name: fl.name, index: fl.index, ptr: fl.ptr, ty: fl.ty })
                            .collect(),
                    })
                    .collect(),
                inline_ptr: facts.inline_ptr,
                inline_types: facts.inline_types,
                inline_tags: facts.inline_tags,
                init_tokens: facts.init_tokens,
                array_elems: facts.array_elems,
                alias_names: facts.alias_names,
                d_pairs: facts.d_pairs,
                dispatch_fields: facts.dispatch_fields,
                array_dispatch_names: facts.array_dispatch_names,
                includes: facts.includes,
            }
        })
        .collect()
}

/// Debug/differential hook: the native `stripCommentsForRegex(text, 'c')`.
/// Exists so the strip differential oracle can pin the Rust stripper against
/// the TS reference directly.
#[napi]
pub fn cfnptr_strip_c(text: String) -> String {
    String::from_utf8_lossy(&cfnptr::strip_c(text.as_bytes())).into_owned()
}

#[napi]
pub fn extract_file(file_path: String, content: String, language: String) -> Result<ExtractBuffers> {
    let out = match language.as_str() {
        "java" => java::extract(&file_path, &content).map_err(Error::from_reason)?,
        "python" => python::extract(&file_path, &content).map_err(Error::from_reason)?,
        "go" => go::extract(&file_path, &content).map_err(Error::from_reason)?,
        "c" | "cpp" => ccpp::extract(&file_path, &content, &language).map_err(Error::from_reason)?,
        "rust" => rustlang::extract(&file_path, &content).map_err(Error::from_reason)?,
        _ => tsjs::extract(&file_path, &content, &language).map_err(Error::from_reason)?,
    };
    Ok(ExtractBuffers {
        meta: out.meta.into(),
        nodes: out.nodes.into(),
        edges: out.edges.into(),
        refs: out.refs.into(),
        arena: out.arena.into(),
    })
}
