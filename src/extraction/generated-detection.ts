/**
 * Generated-file detection for symbol-disambiguation down-ranking.
 *
 * When a query like "Send" matches 17 symbols across protobuf scaffolding,
 * test mocks, and the hand-written implementation, the FTS ranker often
 * surfaces the generated stubs first because their names are identical
 * to the implementation's name (validated empirically on cosmos-sdk —
 * see project_go_multi_module_audit memory). Generated stubs frequently
 * have no body to trace from, so the agent ends up reading source anyway.
 *
 * This is a relevance hint consulted at disambiguation time (findSymbol /
 * findAllSymbols / explore ranking / codegraph_search formatting), NOT a
 * hard filter — generated nodes are still in the graph and remain
 * reachable; they just rank LAST when there's a real implementation with
 * the same name.
 *
 * Two signals, deliberately separate:
 *
 *  1. {@link isGeneratedFile} — PATH only, pure and synchronous. Most
 *     generated files follow the `<basename>.<tool>.<ext>` convention
 *     (`.pb.go`, `_grpc.pb.go`, `.g.dart`, `_pb2.py`). Free to call
 *     anywhere, including in a sort comparator.
 *
 *  2. {@link hasGeneratedHeader} — CONTENT banner in the file's head. Go's
 *     own convention is a content marker, not a filename one, so a
 *     generated `payroll.go` sitting beside hand-written use-cases is
 *     invisible to (1) — that is issue #1500. Evaluated ONCE at index time
 *     (the file's content is already in memory for parsing) and persisted
 *     on the file record as `files.generated`; readers get it from the DB
 *     rather than re-reading headers per request. See
 *     GENERATED_CONTENT_PATTERNS below for the banners recognized.
 *
 * Consumers that have a bounded candidate list should use the DB-backed
 * union (`QueryBuilder.getGeneratedPathsAmong` /
 * `CodeGraph.getGeneratedFilePaths`) so both signals apply; the path-only
 * check remains the fallback for callers with no database in hand and for
 * indexes built before the flag existed.
 *
 * NOTE for future editors: the banner literals quoted in this file sit
 * BELOW the header window this detector scans, so the module does not
 * classify itself. `generated-detection.test.ts` pins that — if you move
 * the pattern table upward, the test fails rather than the repo silently
 * demoting its own file.
 */

const GENERATED_PATTERNS: ReadonlyArray<RegExp> = [
  // Go — protobuf / gRPC / pulsar
  /\.pb\.go$/,
  /\.pulsar\.go$/,
  /_grpc\.pb\.go$/,
  // Go — mockgen output. Default emits `mock_<src>.go`; many projects
  // (cosmos-sdk uses `expected_*_mocks.go`) rename to `*_mock.go` /
  // `*_mocks.go`. Matching either suffix catches both conventions
  // without false-positive risk on hand-written sources.
  /_mock\.go$/,
  /_mocks\.go$/,
  /^mock_[^/]+\.go$/,
  // TypeScript / JavaScript — common codegen suffixes (Apollo / GraphQL
  // codegen, Prisma, Hasura, ts-proto, gRPC-web, swagger-codegen).
  /\.generated\.[jt]sx?$/,
  /\.gen\.[jt]sx?$/,
  /\.pb\.[jt]s$/,
  /_pb\.[jt]s$/,
  /_grpc_pb\.[jt]s$/,
  // Minified bundles vendored into a repo (docs sites, examples). Their
  // single-letter symbols make name-based edges pure noise.
  /\.min\.m?js$/,
  // Python — protobuf / gRPC / openapi-codegen
  /_pb2(_grpc)?\.py$/,
  /_pb2\.pyi$/,
  // C++ — protobuf
  /\.pb\.(cc|h)$/,
  // C# — protobuf / gRPC (protoc-gen-csharp puts output under obj/ but
  // many projects also commit *.g.cs and *Grpc.cs siblings)
  /\.g\.cs$/,
  /Grpc\.cs$/,
  // Java — protobuf / gRPC: protoc-gen-java emits `*OuterClass.java`,
  // protoc-gen-grpc-java emits `*Grpc.java`. The XxxImplBase abstract
  // class lives inside Xxx*Grpc.java.
  /OuterClass\.java$/,
  /Grpc\.java$/,
  // Swift — protobuf
  /\.pb\.swift$/,
  // Dart — build_runner / freezed / json_serializable / chopper
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.pb\.dart$/,
  /\.pbgrpc\.dart$/,
  /\.chopper\.dart$/,
  // Rust — common build.rs OUT_DIR outputs are usually outside the source
  // tree, but in-tree generated files often use `*.generated.rs`.
  /\.generated\.rs$/,
];

/**
 * Whether `filePath` looks like a tool-generated source file based on
 * its filename. Path-only — does not read content. The result is a
 * relevance hint for disambiguation, not a hard claim.
 */
export function isGeneratedFile(filePath: string): boolean {
  return GENERATED_PATTERNS.some((p) => p.test(filePath));
}

// =============================================================================
// Content-header detection (#1500)
// =============================================================================

/**
 * How much of a file's head to consider "the header". Generous enough for a
 * build-tag block + an Apache-2.0 license preamble (~15 lines) sitting above
 * the banner, tight enough that a `"// Code generated ... DO NOT EDIT."`
 * string constant in the *body* of a code generator's own source can't
 * masquerade as a banner.
 */
const HEADER_SCAN_CHARS = 8192;
const HEADER_SCAN_LINES = 60;

/**
 * Cheap pre-filter run on the header of EVERY indexed file. Every marker
 * below contains the stem "generat", so one unanchored scan rejects ~all
 * hand-written source before any line splitting happens — this is what keeps
 * content detection off the index-time cost budget.
 */
const GENERATED_STEM = /generat/i;

/**
 * Line-comment leaders across the languages we index. A banner must sit on a
 * comment line (or inside an open block comment, tracked below): generators
 * always emit theirs as a comment, and requiring it rules out string literals
 * and identifiers that merely contain the words.
 *
 * `--` covers SQL/Haskell/Lua, `%` LaTeX/Erlang/Prolog, `;` Lisp/asm/ini,
 * `'` VB, `!` Fortran, `*` a continuation line inside a `/* … *\/` block.
 */
const COMMENT_LEADER =
  /^\s*(?:\/\/|\/\*+|\*+\/?|#+|--+|<!--|%+|;+|'|!|\(\*|\{-|"""|'''|=begin|<#|@rem\b|rem\b)/i;

/**
 * Openers/closers for block comments, so a banner on an unprefixed line
 * inside `/* … *\/` (or `<!-- … -->`, or a Python module docstring) still
 * counts. Deliberately naive — it only runs over a file's first few dozen
 * lines, where a `/*` inside a string literal is vanishingly rare, and the
 * worst case of a mis-tracked state is a ranking hint, not a wrong answer.
 */
const BLOCK_DELIMS: ReadonlyArray<{ open: string; close: string }> = [
  { open: '/*', close: '*/' },
  { open: '<!--', close: '-->' },
  { open: '"""', close: '"""' },
  { open: "'''", close: "'''" },
  { open: '=begin', close: '=end' },
  { open: '<#', close: '#>' },
];

/**
 * The banners themselves. Each is a real convention emitted by a widely-used
 * generator; the list is precision-first, because a false positive silently
 * demotes hand-written code in every ranking path.
 */
const GENERATED_CONTENT_PATTERNS: ReadonlyArray<RegExp> = [
  // Go's codified convention — `^// Code generated .* DO NOT EDIT\.$`, defined
  // by `go generate` and honored by gofmt, golangci-lint and GitHub linguist.
  // Emitted verbatim by protoc-gen-go, mockgen, sqlc, ent, wire, stringer, and
  // by in-house generators like the FKIT CRUD in #1500 — where the file is
  // named `payroll.go` and nothing in the PATH gives it away.
  /\bcode generated\b.{0,200}?\bdo not edit\b/i,
  // protoc's Java/C#/Python banner ("Generated by the protocol buffer
  // compiler.  DO NOT EDIT!"), ANTLR, Dagger, FlatBuffers, rust-bindgen,
  // Xcode asset catalogs, Bazel rules.
  /\b(?:automatically |auto[- ]?)?generated (?:by|from|with)\b.{0,200}?\bdo not (?:edit|modify|change)\b/i,
  // The `@generated` marker: the JS/TS ecosystem's convention (Relay, GraphQL
  // codegen, protobuf-es/Buf, Meta's `@generated SignedSource<<…>>`), also
  // what linguist and `git diff` collapse on. Guarded against `foo@generated`
  // and `@@generated` so only a standalone tag matches.
  /(?:^|[^\p{L}\p{N}_@])@generated\b/u,
  // .NET's `<auto-generated>` / `<auto-generated />` doc tag: Roslyn, the
  // WinForms designer, T4 templates, protoc-gen-csharp, EF scaffolding.
  /<auto-?generated\s*\/?>/i,
  // swagger-codegen / OpenAPI Generator ("NOTE: This class is auto generated
  // by OpenAPI Generator"), Thrift ("Autogenerated by Thrift Compiler"),
  // FlatBuffers ("automatically generated by the FlatBuffers compiler").
  // "by" is required — bare "automatically generated" appears in hand-written
  // prose ("the table below is automatically generated at runtime").
  /\b(?:automatically generated|auto[- ]?generated|autogenerated) by\b/i,
  // The "run this command to regenerate" shape: Cloudflare Wrangler
  // ("Generated by Wrangler by running `wrangler types` (hash: …)"), and the
  // same phrasing used by other CLI-driven emitters. Bare "generated by" is
  // deliberately NOT enough — it is ordinary prose — so the reproduction
  // instruction is the discriminator: the banner must name a tool AND then
  // say `by running`, i.e. TWO separate "by" clauses. That rules out
  // "the report is generated by running the nightly job", which has only one.
  /\bgenerated by\s+\S.{0,80}?\bby running\b/i,
  // Self-declaring in-house banners that name no tool.
  /\bthis (?:file|class|code|module) (?:is|was) (?:auto[- ]?)?generated\b/i,
  // The reverse ordering: "DO NOT EDIT — this is a generated file".
  /\bdo not (?:edit|modify)\b.{0,120}?\b(?:auto[- ]?generated|generated file|generated code)\b/i,
];

/**
 * Whether the head of `content` carries a recognized machine-generation
 * banner. Bounded to {@link HEADER_SCAN_CHARS} / {@link HEADER_SCAN_LINES},
 * and the marker must sit on a comment line — a generator's own source, which
 * holds the banner as a string constant in its body, is not flagged.
 *
 * Called once per file during extraction (content is already in memory), NOT
 * per query: the verdict is persisted on the file record.
 */
export function hasGeneratedHeader(content: string): boolean {
  if (!content) return false;

  const head = content.length > HEADER_SCAN_CHARS ? content.slice(0, HEADER_SCAN_CHARS) : content;
  // Fast reject for ~every hand-written file: no line splitting, no allocation
  // (V8 keeps `head` as a sliced view of `content`).
  if (!GENERATED_STEM.test(head)) return false;

  const lines = head.split('\n');
  const limit = Math.min(lines.length, HEADER_SCAN_LINES);
  let openBlock: (typeof BLOCK_DELIMS)[number] | null = null;

  for (let i = 0; i < limit; i++) {
    const line = lines[i]!;
    const inBlock = openBlock !== null;

    if (inBlock || COMMENT_LEADER.test(line)) {
      for (const pattern of GENERATED_CONTENT_PATTERNS) {
        if (pattern.test(line)) return true;
      }
    }

    // Advance the block-comment state AFTER testing, so the opening line of a
    // `/* Code generated … */` block is itself matched by the leader rule.
    if (openBlock) {
      if (line.includes(openBlock.close)) openBlock = null;
      continue;
    }
    for (const delim of BLOCK_DELIMS) {
      const at = line.indexOf(delim.open);
      if (at < 0) continue;
      // Same-line close (`/* … */`, a one-line docstring) leaves no open block.
      if (line.indexOf(delim.close, at + delim.open.length) < 0) openBlock = delim;
      break;
    }
  }

  return false;
}

/**
 * The union signal: path convention OR content banner. This is what the
 * indexer persists to `files.generated`.
 */
export function detectGeneratedFile(filePath: string, content: string): boolean {
  return isGeneratedFile(filePath) || hasGeneratedHeader(content);
}
