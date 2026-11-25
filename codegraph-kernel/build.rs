fn main() {
    napi_build::setup();

    // Kotlin grammar — vendored C, compiled here instead of a crate dep: no
    // crates.io release carries this revision (tree-sitter-kotlin 0.3.8 also
    // pins `tree-sitter >= 0.21, < 0.23`; the kernel links 0.25), and
    // tree-sitter-kotlin-ng is a DIFFERENT grammar (renamed kinds —
    // extractor-breaking). Sources are fwcd/tree-sitter-kotlin commit
    // d6af96d2e23ef0a8ff5ab512864378cf08fba311's checked-in generated
    // artifacts, unpatched, the same ones the vendored wasm is built from
    // (docs/grammars/tree-sitter-kotlin.md):
    //   parser.c  d489e0ee02b320ffc1a67c55245b0e150317dfd80321678370c2a2145a0111f3
    //   scanner.c a3c22a33953365af2b6a9408fd7c3828d4c1e83fb95a4ce29a854410ee16e99b
    // Flags crib the commit's own bindings/rust/build.rs (c11: the scanner
    // has a _Static_assert, which MSVC accepts only from /std:c11).
    let mut c = cc::Build::new();
    c.std("c11");
    c.include("grammars/kotlin");
    c.file("grammars/kotlin/parser.c");
    c.file("grammars/kotlin/scanner.c");
    c.flag_if_supported("-Wno-unused-parameter");
    c.flag_if_supported("-Wno-unused-but-set-variable");
    c.flag_if_supported("-Wno-trigraphs");
    c.flag_if_supported("-utf-8"); // msvc
    c.compile("tree-sitter-kotlin");
    println!("cargo:rerun-if-changed=grammars/kotlin");

    // Lua grammar — vendored C (second vendored-grammar-C language): the
    // vendored wasm is tree-sitter-grammars/tree-sitter-lua v0.4.1 (tag
    // 816840c592), which is NOT on crates.io (only 0.1/0.2/0.5 exist; 0.5.0
    // adds Lua-5.5 `global` — a future bump with its own gate). Sources are
    // the v0.4.1 tag's checked-in generated artifacts, sha-recorded in the
    // lua-luau checklist §Grammar prep:
    //   parser.c  b34a362e43f0311f405721f3089e94f97f31da403b154d456d093e64609a4081
    //   scanner.c 35bbd630b5a7421d46d2e91185eeea09bf78565d44cb676b63ca20d0f1b54bbd
    let mut lua = cc::Build::new();
    lua.include("grammars/lua");
    lua.file("grammars/lua/parser.c");
    lua.file("grammars/lua/scanner.c");
    lua.flag_if_supported("-Wno-unused-parameter");
    lua.flag_if_supported("-Wno-unused-but-set-variable");
    lua.flag_if_supported("-Wno-trigraphs");
    lua.flag_if_supported("-utf-8"); // msvc
    lua.compile("tree-sitter-lua");
    println!("cargo:rerun-if-changed=grammars/lua");

    // Scala grammar — vendored C (third vendored-grammar-C language): the
    // vendored wasm is the tree-sitter/tree-sitter-scala v0.26.2 release asset,
    // and these sources are the same tag's checked-in generated artifacts
    // (#1823 — the previous master@0aca5d0a6f pin truncated an `extends`
    // clause after a parent with several argument lists):
    //   parser.c  9f6d03fa6c63d2d855b6f9e0368046a58568587eefc38b5e38bdb001e8ec68db
    //   scanner.c daed58e6cf61f5b034adf51029c566141da5fb181540b77c8a28654a26e4ddd7
    // parser.c is ~27 MB — the biggest grammar in the tree; expect a slow cc
    // step on clean builds.
    let mut scala = cc::Build::new();
    scala.include("grammars/scala");
    scala.file("grammars/scala/parser.c");
    scala.file("grammars/scala/scanner.c");
    scala.flag_if_supported("-Wno-unused-parameter");
    scala.flag_if_supported("-Wno-unused-but-set-variable");
    scala.flag_if_supported("-Wno-trigraphs");
    scala.flag_if_supported("-utf-8"); // msvc
    scala.compile("tree-sitter-scala");
    println!("cargo:rerun-if-changed=grammars/scala");

    // Dart grammar — vendored C (fourth vendored-grammar-C language). Sources
    // are UserNobody14/tree-sitter-dart master@0038280b774b (2026-10-18; Dart
    // 3.13 primary constructors, #3270), byte-identical to the commit's src/,
    // and src/extraction/wasm/tree-sitter-dart.wasm is built from the same
    // files (docs/grammars/tree-sitter-dart.md):
    //   parser.c  9570f47f9912a4b169f5d959f6db06859087eb95c3f1203e312a33c12da66309
    //   scanner.c 07a7b7818b175e9460523e705dd88d20f7b5141bac95c593d4426e6d52284996
    // crates.io tree-sitter-dart is the nielsenko FORK (different lineage) —
    // rejected. scanner.c is load-bearing: string-template char classes and
    // /** */ doc comments are external tokens.
    let mut dart = cc::Build::new();
    dart.include("grammars/dart");
    dart.file("grammars/dart/parser.c");
    dart.file("grammars/dart/scanner.c");
    dart.flag_if_supported("-Wno-unused-parameter");
    dart.flag_if_supported("-Wno-unused-but-set-variable");
    dart.flag_if_supported("-Wno-trigraphs");
    dart.flag_if_supported("-Wno-unused-function");
    dart.flag_if_supported("-utf-8"); // msvc
    dart.compile("tree-sitter-dart");
    println!("cargo:rerun-if-changed=grammars/dart");

    // Swift grammar — vendored C (fifth vendored-grammar-C language): the
    // crates.io tree-sitter-swift 0.7.4 tarball's src/ (#3212), the same
    // sources the vendored wasm is built from (swift checklist §Grammar prep),
    // with docs/grammars/tree-sitter-swift.patch applied to scanner.c: its
    // out-of-memory report uses stdio, which a wasm parser lacks, and both
    // are built from one scanner. (0.7.4 also carries the `1ULL <<
    // FAKE_TRY_BANG` fix the previous patch added for MSVC's `try!`.)
    //   parser.c  1d332e60ec28e6b398db36e06bf05414061dfbbd3e981b33ff1edfd5159e3e08
    //   scanner.c b0abca0bb8d9e34da210ef0fac14f67c4fb40cb2625c4e51bd42ea80ac59d1b1
    //   scanner.c 2b78cad2a49da126388acfa67fdac585226f89cd2feaf4326e98289bc253bf87 (patched)
    // Flags crib the tarball's own bindings/rust/build.rs (c11). parser.c is
    // ~20 MB.
    let mut swift = cc::Build::new();
    swift.std("c11");
    swift.include("grammars/swift");
    swift.file("grammars/swift/parser.c");
    swift.file("grammars/swift/scanner.c");
    swift.flag_if_supported("-Wno-unused-parameter");
    swift.flag_if_supported("-Wno-unused-but-set-variable");
    swift.flag_if_supported("-Wno-trigraphs");
    swift.flag_if_supported("-utf-8"); // msvc
    swift.compile("tree-sitter-swift");
    println!("cargo:rerun-if-changed=grammars/swift");
}
