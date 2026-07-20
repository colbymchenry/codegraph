//! Grammar registry: codegraph `Language` string → native tree-sitter grammar.
//!
//! Mirrors the wasm side's `WASM_GRAMMAR_FILES` mapping (src/extraction/
//! grammars.ts): `tsx` and `jsx` reuse another language's grammar exactly the
//! way the wasm map does. The kernel-grammar-parity test asserts each entry is
//! built from the SAME grammar revision as the vendored wasm — bump the crate
//! and the wasm together.
//!
//! (R1 shipped a generic `.scm`-query emitter here; R2 replaced it with the
//! bespoke per-language walker — see tsjs/ and the migration plan §3a — because
//! extraction parity needs logic queries can't express. New languages add a
//! grammar entry + a walker module.)

use tree_sitter::Language;

/// Languages this kernel binary can extract (reported by contractInfo;
/// TS-side routing policy decides what actually routes).
pub const LANGUAGES: [&str; 10] =
    ["typescript", "tsx", "javascript", "jsx", "java", "python", "go", "c", "cpp", "rust"];

pub fn grammar_for(language: &str) -> Option<Language> {
    match language {
        "typescript" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "javascript" | "jsx" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        // `.metal`/`.cu`/`.cuh` map to language 'cpp' at detectLanguage, so the
        // dialects ride this grammar too (their blanking pre-passes stay
        // TS-side — the route point applies preParse before the kernel call).
        "c" => Some(tree_sitter_c::LANGUAGE.into()),
        "cpp" => Some(tree_sitter_cpp::LANGUAGE.into()),
        // R7b: v0.24.2, sha-matched with the vendored wasm (grammars.ts).
        "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
        _ => None,
    }
}
