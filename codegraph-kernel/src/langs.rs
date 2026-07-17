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
pub const LANGUAGES: [&str; 7] =
    ["typescript", "tsx", "javascript", "jsx", "java", "python", "go"];

pub fn grammar_for(language: &str) -> Option<Language> {
    match language {
        "typescript" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "javascript" | "jsx" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        _ => None,
    }
}
