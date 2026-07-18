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
mod docstring;
mod ids;
mod go;
mod java;
mod langs;
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

#[napi]
pub fn extract_file(file_path: String, content: String, language: String) -> Result<ExtractBuffers> {
    let out = match language.as_str() {
        "java" => java::extract(&file_path, &content).map_err(Error::from_reason)?,
        "python" => python::extract(&file_path, &content).map_err(Error::from_reason)?,
        "go" => go::extract(&file_path, &content).map_err(Error::from_reason)?,
        "c" | "cpp" => ccpp::extract(&file_path, &content, &language).map_err(Error::from_reason)?,
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
