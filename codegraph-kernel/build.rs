fn main() {
    napi_build::setup();

    // Kotlin grammar — vendored C, compiled here instead of a crate dep: the
    // crates.io tree-sitter-kotlin 0.3.8 pins `tree-sitter >= 0.21, < 0.23`
    // (the kernel links 0.25) and tree-sitter-kotlin-ng is a DIFFERENT
    // grammar (8 fields vs 0, renamed kinds — extractor-breaking). Sources
    // are the fwcd 0.3.8 tag's checked-in generated artifacts, sha-matched
    // against the crates.io tarball (kotlin checklist §Grammar prep):
    //   parser.c  54104a7ef1555c265b746c790e0f8bb953cc17806e9df0c3af82f7f62c06a70a
    //   scanner.c 27f73337ec357fc341fa57538f34c14277b0346980c3405dc30beab6202ec6d0
    // Flags crib the tarball's own bindings/rust/build.rs.
    let mut c = cc::Build::new();
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

    // Dart grammar — vendored C (fourth vendored-grammar-C language): the
    // production wasm is the tree-sitter-wasms 0.1.13 artifact, whose dart
    // dependency is an UNPINNED github:UserNobody14/tree-sitter-dart — the
    // vendored wasm byte-copy (src/extraction/wasm/) plus these same-commit
    // sources kill that hazard. crates.io tree-sitter-dart is the nielsenko
    // FORK (different lineage) — rejected. Sources are
    // UserNobody14/tree-sitter-dart master@d4d8f3e337d8 (dart checklist
    // §Grammar prep):
    //   parser.c  5a42b47abb4d494f125dbdee9138979248041689b1aa36355550fa3e28dcb8b8
    //   scanner.c 07a7b7818b175e9460523e705dd88d20f7b5141bac95c593d4426e6d52284996
    // scanner.c is load-bearing: string-template char classes and /** */ doc
    // comments are external tokens.
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
}
