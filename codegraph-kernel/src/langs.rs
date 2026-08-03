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

// Vendored kotlin grammar (build.rs-compiled C — no usable crate exists;
// see grammars/kotlin and the kotlin checklist §Grammar prep).
extern "C" {
    fn tree_sitter_kotlin() -> *const ();
}
// Vendored lua grammar (build.rs-compiled C — the wasm's v0.4.1 revision is
// not on crates.io; see grammars/lua and the lua-luau checklist).
extern "C" {
    fn tree_sitter_lua() -> *const ();
}
// Vendored scala grammar (build.rs-compiled C — the wasm is master@0aca5d0a6f,
// 30 states past the v0.26.0 crate; see grammars/scala and the scala checklist).
extern "C" {
    fn tree_sitter_scala() -> *const ();
}
// Vendored dart grammar (build.rs-compiled C — UserNobody14 d4d8f3e; the
// crates.io crate is a different-lineage fork; see grammars/dart).
extern "C" {
    fn tree_sitter_dart() -> *const ();
}

/// Languages this kernel binary can extract (reported by contractInfo;
/// TS-side routing policy decides what actually routes).
pub const LANGUAGES: [&str; 20] = [
    "typescript", "tsx", "javascript", "jsx", "java", "python", "go", "c", "cpp", "rust",
    "csharp", "ruby", "php", "swift", "kotlin", "r", "lua", "luau", "scala", "dart",
];

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
        // R7b: 0.23.5, table-identical to the vendored ABI-15 wasm (#717;
        // verified against the crates.io tarball — csharp checklist header).
        "csharp" => Some(tree_sitter_c_sharp::LANGUAGE.into()),
        // R7b: v0.23.1, sha-matched with the vendored wasm (grammars.ts).
        // Content bump only — the tag's parser.c is still ABI 14.
        "ruby" => Some(tree_sitter_ruby::LANGUAGE.into()),
        // R7b: v0.24.2, the full HTML-interleaving variant — LANGUAGE_PHP,
        // NEVER LANGUAGE_PHP_ONLY (which errors on leading HTML).
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        // R7b: crate 0.7.3 — the vendored wasm is built from this crate's own
        // tarball src/ (table identity by construction; see grammars.ts).
        "swift" => Some(tree_sitter_swift::LANGUAGE.into()),
        // R7b: fwcd 0.3.8, vendored C compiled in build.rs (crate unusable).
        "kotlin" => {
            Some(unsafe { tree_sitter_language::LanguageFn::from_raw(tree_sitter_kotlin) }.into())
        }
        // R7b batch 4: crate =1.2.0, sha-identical to the r-lib v1.2.0 tag
        // the vendored wasm was built from (r checklist §Grammar prep).
        "r" => Some(tree_sitter_r::LANGUAGE.into()),
        // R7b batch 4: v0.4.1 vendored C compiled in build.rs (revision not
        // on crates.io — the wasm is the v0.4.1 tag, table-identical).
        "lua" => {
            Some(unsafe { tree_sitter_language::LanguageFn::from_raw(tree_sitter_lua) }.into())
        }
        // R7b batch 4: crate =1.2.0, sha-identical to the v1.2.0 tag the
        // vendored wasm was built from (lua-luau checklist §Grammar prep).
        "luau" => Some(tree_sitter_luau::LANGUAGE.into()),
        // R7b batch 4: master@0aca5d0a6f vendored C compiled in build.rs (the
        // revision is not a release — crate 0.26.0 is 30 states behind).
        "scala" => {
            Some(unsafe { tree_sitter_language::LanguageFn::from_raw(tree_sitter_scala) }.into())
        }
        // R7b batch 4: UserNobody14 d4d8f3e vendored C compiled in build.rs
        // (same commit as the byte-copied tree-sitter-wasms 0.1.13 artifact).
        "dart" => {
            Some(unsafe { tree_sitter_language::LanguageFn::from_raw(tree_sitter_dart) }.into())
        }
        _ => None,
    }
}
