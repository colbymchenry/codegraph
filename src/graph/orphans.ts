/**
 * Orphans: symbols a branch ADDED that nothing in the index uses.
 *
 * ADDED. A symbol S in the index (the HEAD / working-tree index) is added
 * since merge-base(base, HEAD) when, for S's file in `changedFiles(root, base)`
 * (`./git-diff`, the `base...HEAD` range):
 *   1. the file's status is `added`; or
 *   2. S's declaration line (`start_line`) lies inside one of the file's
 *      post-image changed ranges AND S's name does not occur as a whole word
 *      anywhere in the file's pre-image, read with
 *      `git show <mergeBaseSha>:./<oldPath ?? path>` from the project root
 *      (one read per modified or renamed file that has a candidate). A name
 *      present in the pre-image means the declaration was edited (signature
 *      change, moved within the file), not added.
 * Consequences: a function moved to another file counts as added in the new
 * file (its callers usually keep it off the list); an added overload of an
 * existing name is NOT added (its name is in the pre-image), an accepted false
 * negative. A pre-image that cannot be read is counted in `preImageUnread`, and
 * that file's candidates are taken as added by the range test alone.
 *
 * Only declaration kinds are checked (`CANDIDATE_KINDS`): variables, constants,
 * fields and properties are not, because reads of them are under-edged in the
 * index and most would be false orphans.
 *
 * ORPHAN RULE. Incoming edges of every kind except `contains` and `exports`
 * count as uses, minus those whose source is S itself or a node inside S's
 * span in S's file (recursion, nested closures). For a type, the uses of every
 * same-language type node with S's name count (the Swift extension grouping: a
 * Swift `extension X` is a node of its own). Every counted use a guess: listed
 * as "orphaned unless the guess is right", with the guessed edges. No counted
 * use is a suspicion, not a finding (the resolver misses cross-crate calls and
 * many Swift type uses), so two cheap checks run before S is called orphaned,
 * in this order:
 *   - unresolved-reference check: the FAILED `unresolved_refs` rows whose
 *     `name_tail` equals S's name (one batched `name_tail IN (...)` lookup for
 *     every suspect), minus rows whose from-node is S itself or lies inside
 *     S's span in S's file, and minus rows from another language than S's
 *     (the same-language rule: `unresolved_refs.language` against
 *     `nodes.language`, the JS family counting as one language; a Swift
 *     `close()` call is no evidence for a Python `close`). Any left: S is
 *     guessed, with them as `unresolved` evidence, most telling first: rows
 *     whose qualifier (the name before the last `.` / `::`) ends with the name
 *     of a type containing S, then rows from S's own file, then the rest, each
 *     by path and line;
 *   - text-mention check (the `rg -w` step a reader would run): for the
 *     suspects the unresolved-reference check left, one word-bounded search of
 *     every indexed file for all their names at once, through `grepIndex`
 *     (`../search/grep`). A hit outside S's own span in S's own file (anywhere in
 *     another file) makes S guessed, with the hits as `mentions` evidence.
 *     Comments and strings count: the list is "orphaned unless the guess is
 *     right". A name that is not an identifier (a Swift operator such as `==`)
 *     is not searched. The names go to the search in batches whose pattern
 *     fits in one ripgrep argument (`mentionBatches`, `MENTION_PATTERN_BYTES`).
 *     A run keeps at most `MENTION_SEARCH_CAP` hits; when it drops some, its
 *     names still without a mention are searched again while that settles
 *     some, and a name a batched run cannot settle is searched alone, keeping
 *     `MENTION_SEARCH_CAP` hits plus as many as the largest own span of its
 *     suspects still without a mention can hold (one hit per line), so a run
 *     that still drops hits has kept one outside each of those spans.
 *     A name the check still cannot settle (its own run dropped hits and
 *     kept none outside, which only a file changing during the run can cause,
 *     or a name too long to pass to ripgrep) makes `findOrphans` throw
 *     `MentionSearchIncompleteError` rather than call it orphaned.
 *     `mentionCount` counts the hits the runs kept, so it can undercount. An
 *     indexed file the search cannot open (missing, unreadable, or leading
 *     outside the project; `grepIndex` skips it and counts it in
 *     `truncated.files`) is not searched. The report's `searchUnread` is the
 *     most such files one run skipped: every run searches every indexed file,
 *     so the runs count the same files and are not summed. It is 0 when no
 *     run was needed. The text report prints it under the orphaned list.
 * ORPHANED therefore means: no counted incoming edge; no failed unresolved
 * reference with S's name from outside S in the same language (the JS family
 * counting as one language); and, for an identifier name only (operators such
 * as `==` are not searched), no word match outside S's own span in the files
 * the search could open (`searchUnread` counts the ones it could not).
 *
 * GUESS (the guess rule), per incoming edge, by its kind:
 *   - `calls`: the shared questionable-edge predicate, exactly
 *     (`isCandidateEdge` in `./suspects`, whose SQL form `candidateEdgeSql`
 *     grep and blast use, so the three commands mark the same call edges):
 *     `resolvedBy` is `fuzzy` at any confidence; or
 *     `exact-match` when the caller's file differs from the edge's own target's
 *     file (a same-file exact match is the local definition, so it is certain;
 *     for a type the target may be another node of its same-name group, in
 *     another file than S's); or
 *     `instance-method` with a confidence below 0.9 (a missing confidence
 *     counts as 1).
 *   - every other counted kind (references, imports, extends, ...): the shared
 *     predicate is defined over `calls` only, and orphans counts every incoming
 *     kind but `contains` / `exports`, so these keep orphans' own rule, which
 *     reads the resolver's confidence rather than the files: `resolvedBy` is `fuzzy`; or
 *     `exact-match` with a numeric confidence below `CERTAIN_NAME_MATCH` (0.9;
 *     multi-candidate matches score 0.4 / 0.7); or any numeric confidence is
 *     below `LOW_CONFIDENCE` (0.7).
 * Any other edge is certain; under both rules that includes an edge with no
 * metadata (extraction-local, synthesized).
 *
 * EXCLUSIONS, checked in this order before the orphan rule and counted per
 * reason:
 *   - test (the test rule): the file is a test file (`isTestPath`); or the name matches
 *     `TEST_NAME`; or the start line, or a line just above it (walking up over
 *     attributes, comments and blanks, at most `ATTRIBUTE_LOOKBACK` lines),
 *     carries a test attribute of S's language (`testAttributeFor`): in a Rust
 *     file `#[test]`, `#[<path>::test]`, `#[rstest]`; in a Swift file `@Test`;
 *     in any other language none. A comment line (`COMMENT_LINE`: `//`, `///`,
 *     `/*` or `*` first) is walked over but never read as an attribute, so
 *     `// @Test` above a function marks nothing.
 *     Nested in a test (the nested-in-test rule): S's span lies inside another symbol of the same
 *     file that is a test by name or attribute (a helper type and its impl
 *     declared inside a `#[test]` fn: the extractor gives such an impl no
 *     implements edge and no unresolved ref, so nothing else catches it); or,
 *     in a Rust file, inside a `mod` whose declaration carries `#[cfg(test)]`.
 *     Rust modules are not nodes, so that module's extent is read from the
 *     tree-sitter Rust parse of the file (`cfgTestRanges`, the grammar the
 *     indexer uses: strings and comments are what the parser says they are);
 *   - entry (the entry-point rule): a top-level `function` named `main` (no
 *     function or method holds it); a Swift type whose declaration carries
 *     `@main` (the same attribute walk as the test rule, comments never
 *     matched; `@main` in any other language marks nothing); a method or
 *     function named `main` held by such a type. The runtime calls these;
 *     nothing in the index does;
 *   - implementation, for a method or function S, in this order:
 *     Requirements (the requirement rule): S is held by an interface, trait or
 *     protocol node (a requirement, reached through its implementations, so it
 *     has no incoming edge of its own), and that container has a counted use;
 *     a guessed use counts here, since the requirement is only ever as dead as
 *     its container.
 *     Indexed conformances (the indexed-conformance check): S's containing
 *     type (via `contains`; for Swift also every same-named type node)
 *     reaches, over `implements` / `extends` edges up to `CONFORMANCE_DEPTH`
 *     hops, an indexed type T that contains a member named S.name or whose
 *     source span holds S.name as a whole word (Swift protocol requirements
 *     are not nodes). Nothing emits `overrides` edges, so they are not
 *     consulted. A TS / Rust implementation's synthesized `calls` edge from
 *     the interface member does not matter: this runs before the orphan rule.
 *     External conformances (the external-conformance table): when the
 *     containing type has failed `extends` / `implements` unresolved refs (a
 *     type the index does not hold), S is an implementation only when
 *     `EXTERNAL_REQUIREMENTS`, a HEURISTIC table of well-known requirement
 *     names, lists S.name for that type; otherwise S stays listed with
 *     `externalConformances` naming them;
 *   - constructor (the constructor rule): S is named constructor / init / __init__ / new and its
 *     containing type has a counted use.
 */
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { parseWithinBudget } from '../extraction/parse-budget';
import { isTestPath } from '../search/query-utils';
import type { BlastNode } from './blast';
import type { ChangedFile } from './git-diff';
import type { FailedRef, IncomingUse, OrphanNode, OrphansStore } from './orphans-store';
import { isCandidateEdge } from './suspects';

/** Node kinds checked for orphans: declarations a caller names. */
export const CANDIDATE_KINDS: ReadonlySet<string> = new Set([
  'function', 'method', 'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'type_alias', 'component', 'union',
]);

/** Kinds that are a type: the containing-type, Swift-extension-grouping and conformance-target kinds. */
const TYPE_KINDS = ['class', 'struct', 'enum', 'protocol', 'interface', 'trait', 'union'] as const;
const TYPE_KIND_SET: ReadonlySet<string> = new Set(TYPE_KINDS);

/** Kinds the implementation exclusion applies to. */
const MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'function']);

/** Names the constructor exclusion applies to. */
const CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(['constructor', 'init', '__init__', 'new']);

/** Below this, a non-call edge is a guess (a call is judged by isCandidateEdge instead): 0.7 is the lowest common resolver tier (single-candidate file-path fallback and the like). */
export const LOW_CONFIDENCE = 0.7;
/** A non-call `exact-match` edge at or above this is the single-candidate name match, treated as certain (a call is judged by isCandidateEdge instead). */
export const CERTAIN_NAME_MATCH = 0.9;

/** Test-function naming conventions: `testFoo` / `test_foo` / `test1` (XCTest, Rust, Python), `TestFoo` (Go). */
const TEST_NAME = /^test[A-Z_0-9]|^Test[A-Z_]/;
/** Rust's test attributes, read in Rust files only: `#[test]`, `#[tokio::test]` (any path ending in `test`), `#[rstest]`. */
const RUST_TEST_ATTRIBUTE = /#\[\s*(?:[A-Za-z_]\w*::)*test\b|#\[\s*rstest\b/;
/** Swift Testing's `@Test`, read in Swift files only. */
const SWIFT_TEST_ATTRIBUTE = /@Test\b/;
/**
 * The test rule's attribute for a file of `language`: Rust's in a Rust file, Swift's in a
 * Swift file, none in any other. So a Java `@Test` annotation, a Python `@Test` decorator
 * or a Python `#[test]` comment excludes nothing (a test there is caught by `isTestPath` or
 * `TEST_NAME`, or not at all).
 */
function testAttributeFor(language: string): RegExp | null {
  if (language === 'rust') return RUST_TEST_ATTRIBUTE;
  if (language === 'swift') return SWIFT_TEST_ATTRIBUTE;
  return null;
}
/** A line the attribute walk passes over: blank, an attribute, or a comment. */
const ATTRIBUTE_OR_COMMENT = /^\s*(?:$|#\[|@|\/\/|\/\*|\*)/;
/**
 * A comment line: `//` (and so `///`), `/*` or `*` first after whitespace. The attribute walk
 * passes over it but never reads it as an attribute, so `// @Test` or `/// #[test]` marks
 * nothing. A line inside a block comment that starts with none of these is not seen as a
 * comment.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/**
 * How many lines the attribute walk looks above a start line (test and entry
 * attributes, `hasAttribute`). 5 covers a doc comment line plus a few stacked attributes.
 */
const ATTRIBUTE_LOOKBACK = 5;

/**
 * Swift's program entry attribute (the entry-point rule), read in Swift files only, so a Python
 * `@main` decorator marks nothing. `\b` keeps `@mainActor`-style names out; `@MainActor` differs in case.
 */
const MAIN_ATTRIBUTE = /@main\b/;
/** The entry-point name (the entry-point rule): Rust / C-family `fn main`, Swift's `static func main()` on an `@main` type. */
const ENTRY_NAME = 'main';
/** Kinds whose `main` member is not top-level (the entry-point rule): a `main` held by a function or method is a local. */
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

/** Container kinds whose members are requirements (the requirement rule). */
const REQUIREMENT_CONTAINER_KINDS: ReadonlySet<string> = new Set(['interface', 'trait', 'protocol']);

/**
 * The text-mention search's hit cap per batched run (`grepIndex` `maxHits`); see the
 * header for what happens past it. `grepIndex` holds at most twice its `maxHits` at
 * once, and this cap is far above what one name gets in a large repo; re-runs cover
 * the names the cap cut. A name searched alone gets `maxHits` = this + `own`, where
 * `own` is the largest `ownHitBound` among its suspects still without a mention: the
 * lines of that suspect's own span that contain the name, or every line of the span
 * as indexed when its file cannot be read. So that run holds at most
 * 2 * (MENTION_SEARCH_CAP + own) hits at once; `own` has no cap of its own.
 */
export const MENTION_SEARCH_CAP = 10_000;

/**
 * Bytes one text-mention pattern may take (`mentionBatches`). `grepIndex` hands the
 * pattern to ripgrep as one argument (`-e <pattern>`), and Linux refuses a single
 * argument over 128 KiB (MAX_ARG_STRLEN) with E2BIG, which would fail the spawn.
 * Half of that leaves room; it also sits well inside macOS's 1 MB cap on argv plus
 * environment beside grep's own path batches (200 KB).
 */
export const MENTION_PATTERN_BYTES = 64 * 1024;

/**
 * The text-mention check could not finish for a name, so `findOrphans` cannot call
 * that name's suspects orphaned: the name searched alone still dropped hits and kept
 * none outside one suspect's own span, so that suspect has no mention (only a file
 * changing during the run can cause it), or its pattern alone is over
 * `MENTION_PATTERN_BYTES`. `runOrphans` reports it as a failure.
 */
export class MentionSearchIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MentionSearchIncompleteError';
  }
}

/** A name the text-mention check can word-search: identifier characters only. */
const IDENTIFIER_NAME = /^[\p{L}\p{N}_$]+$/u;

/**
 * The same-language rule's language key. One file's language is compared with S's; the JS family
 * (`.ts` calling a `.tsx` export, a `.vue` script calling a `.ts` one) is one
 * language here, since its files call each other all the time.
 */
const JS_FAMILY: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx', 'vue', 'svelte', 'astro']);
const languageKey = (language: string): string => (JS_FAMILY.has(language) ? 'js' : language);

/**
 * The unresolved-reference check's rank of a failed reference for S: 0 when the reference's qualifier
 * (its name before the last `.` or `::`) ends, as a whole word, with the name
 * of a type containing S (`RunCommand.run`, `self.cmd.RunCommand.run`);
 * 1 when it is in S's own file; 2 otherwise.
 */
function refRank(referenceName: string, path: string, s: { path: string }, containerNames: readonly string[]): number {
  const cut = Math.max(referenceName.lastIndexOf('.'), referenceName.lastIndexOf('::'));
  if (cut > 0) {
    const qualifier = referenceName.slice(0, cut);
    for (const t of containerNames) {
      if (qualifier.endsWith(t) && !/[\p{L}\p{N}_$]/u.test(qualifier.charAt(qualifier.length - t.length - 1))) return 0;
    }
  }
  return path === s.path ? 1 : 2;
}

/**
 * How many `implements` / `extends` hops the indexed-conformance check follows.
 * Conformance chains deeper than this are rare; the bound stops a cyclic or very
 * deep hierarchy from walking the graph.
 */
const CONFORMANCE_DEPTH = 5;

/**
 * Requirement names of well-known types outside the index, per language, keyed
 * by the type's last path segment (generic arguments dropped). A HEURISTIC:
 * the index holds no node for these types, so their requirements cannot be
 * read, and this curated list covers the common conformances whose methods are
 * called only by the language runtime or a framework. A member of a type that
 * conforms to an external type not listed here, or under a name not listed,
 * stays reported with the conformance named so the reader can judge.
 */
const EXTERNAL_REQUIREMENTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  swift: {
    Hashable: ['hash', '=='],
    Equatable: ['=='],
    Comparable: ['<'],
    Encodable: ['encode'],
    Decodable: ['init'],
    Codable: ['encode', 'init'],
    CustomStringConvertible: ['description'],
    Identifiable: ['id'],
    // Error has no required members, so this entry excludes nothing; it is listed to record that Error was considered.
    Error: [],
  },
  rust: {
    Display: ['fmt'],
    Debug: ['fmt'],
    Default: ['default'],
    From: ['from'],
    TryFrom: ['try_from'],
    FromStr: ['from_str'],
    Drop: ['drop'],
    Iterator: ['next'],
    Clone: ['clone'],
    PartialEq: ['eq', 'ne'],
    PartialOrd: ['partial_cmp'],
    Ord: ['cmp'],
    Hash: ['hash'],
    Deref: ['deref'],
    DerefMut: ['deref_mut'],
    AsRef: ['as_ref'],
    Future: ['poll'],
    Serialize: ['serialize'],
    Deserialize: ['deserialize'],
    Error: ['source'],
  },
};

/** One listed symbol. `span` is `L<start>-L<end>`, as blast reports it. */
export interface OrphanEntry {
  id: string;
  name: string;
  kind: string;
  path: string;
  span: string;
  /** External types S's containing type conforms to (the external-conformance table), when S was not excluded by the table. */
  externalConformances?: string[];
}

/** A guessed incoming edge, as reported. */
export interface GuessEdge {
  source: string;
  sourceName: string;
  sourcePath: string;
  line: number;
  kind: string;
  resolvedBy: string | null;
  confidence: number | null;
}

/** A failed unresolved reference naming S (the unresolved-reference check), as reported. */
export interface UnresolvedEvidence {
  /** The reference as written (`other_crate::cross_target`). */
  name: string;
  /** `unresolved_refs.reference_kind` (`calls`, `references`, ...). */
  kind: string;
  path: string;
  line: number;
}

/** A line naming S outside S's own span (the text-mention check). */
export interface MentionEvidence {
  path: string;
  line: number;
}

/**
 * A listed symbol with the evidence that something may use it. `edges` holds
 * every guessed incoming edge, by source path then line; `unresolved` every
 * failed reference the unresolved-reference check kept, most telling first
 * (container-qualified, then S's own file, then the rest, each by path and
 * line: `refRank`); `mentions` the mention lines the text-mention search
 * kept, by path then line, which can be fewer than there are (the search
 * caps its hits, see the header). The renderers cap what they print
 * (`./render.ts`) and the counts say how many each list holds. A symbol is
 * put here by the first stage that finds evidence (edges, then the
 * unresolved-reference check, then the text-mention check), so the later
 * lists of an entry an earlier stage put here are empty.
 */
export interface GuessedEntry extends OrphanEntry {
  edges: GuessEdge[];
  unresolved: UnresolvedEvidence[];
  mentions: MentionEvidence[];
  edgeCount: number;
  unresolvedCount: number;
  mentionCount: number;
}

export interface OrphansReport {
  /** How many symbols the range added (every candidate, excluded or not). */
  added: number;
  orphans: OrphanEntry[];
  guessed: GuessedEntry[];
  excluded: { test: number; implementation: number; constructor: number; entry: number };
  /** Modified or renamed files whose pre-image could not be read. */
  preImageUnread: number;
  /**
   * Indexed files the text-mention search could not read, so a mention there would be
   * missed: the most any one search run skipped (see the header), 0 when none ran.
   */
  searchUnread: number;
}

/** One line a text search matched, by project-relative path. */
export interface TextHit {
  path: string;
  line: number;
  /** The matched line as the search reported it (possibly trimmed or cut); used only when the file cannot be read. */
  text: string;
}

/** What `findOrphans` reads besides the index: the pre-image and working-tree text of a file, and the text-mention search. */
export interface OrphansIO {
  /** The file's text at the merge base (`oldPath ?? path`), or null when it cannot be read. */
  preImage(file: ChangedFile): string | null;
  /** The file's current text, by project-relative path, or null when it cannot be read. */
  source(path: string): string | null;
  /**
   * Search every indexed file for the ripgrep regex `pattern`, keeping at most
   * `maxHits` hits, one per matching line (`findOrphans`' single-name runs rely
   * on that); `truncated` is true when hits past the cap were dropped; `unread`
   * counts the indexed files the search could not read.
   */
  search(pattern: string, maxHits: number): Promise<{ hits: TextHit[]; truncated: boolean; unread: number }>;
}

/**
 * True when an edge of `kind` carrying `metadata` (edges.metadata, parsed) is a
 * guess under the guess rule (see the header). A `calls` edge is a guess
 * exactly when `isCandidateEdge` holds for it, given the caller's
 * file `sourcePath` and the target's file `targetPath` (a same-file exact
 * match is certain); any other kind by orphans' own confidence rule, where
 * `fuzzy` is a guess whatever its confidence and the files are not read.
 */
export function isGuess(kind: string, metadata: Record<string, unknown>, sourcePath: string, targetPath: string): boolean {
  if (kind === 'calls') return isCandidateEdge(kind, metadata, sourcePath, targetPath);
  const by = metadata.resolvedBy;
  const c = metadata.confidence;
  const conf = typeof c === 'number' && Number.isFinite(c) ? c : null;
  if (by === 'fuzzy') return true;
  if (by === 'exact-match' && conf !== null && conf < CERTAIN_NAME_MATCH) return true;
  return conf !== null && conf < LOW_CONFIDENCE;
}

/** Characters that make up an identifier, for the whole-word tests. */
const IDENT = '[\\p{L}\\p{N}_$]';

/**
 * True when `name` occurs in `text` with no identifier character on either
 * side. Lookarounds rather than `\b`, so an operator name (`==`) or a `$` name
 * is tested the same way.
 */
export function containsWord(text: string, name: string): boolean {
  if (name === '') return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  return new RegExp(`(?<!${IDENT})${escaped}(?!${IDENT})`, 'u').test(text);
}

function spanLines(span: string): { start: number; end: number } {
  const m = /^L(\d+)-L(\d+)$/.exec(span);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : { start: 0, end: 0 };
}

/** A type's last path segment with generic arguments dropped: `std::fmt::Display` → `Display`, `From<T>` → `From`. */
function lastSegment(ref: string): string {
  const bare = ref.replace(/<.*$/s, '').trim();
  const parts = bare.split(/::|\.|\//);
  return parts[parts.length - 1] ?? bare;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * An identifier (`IDENTIFIER_NAME`) escaped for both a JS `u` regex and a
 * ripgrep regex: `$` is its only metacharacter.
 */
function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$');
}

/**
 * The text-mention check's ripgrep pattern: any of `names` with no identifier character on either
 * side (the line's start or end counts as a boundary). `names` must be
 * identifiers (`IDENTIFIER_NAME`).
 */
export function mentionPattern(names: readonly string[]): string {
  const id = '[^\\p{L}\\p{N}_$]';
  return `(?:^|${id})(?:${names.map(escapeName).join('|')})(?:${id}|$)`;
}

/**
 * `names`, in order, split into batches whose `mentionPattern` takes at most
 * `maxBytes` UTF-8 bytes (each name is costed with one `|` separator, so a
 * batch's pattern is a byte under its count). A name too long for a batch of
 * its own still gets one, so no batch is empty; `findOrphans` refuses to
 * search a name whose pattern alone is over `MENTION_PATTERN_BYTES`.
 */
export function mentionBatches(names: readonly string[], maxBytes: number = MENTION_PATTERN_BYTES): string[][] {
  const overhead = Buffer.byteLength(mentionPattern([]));
  const batches: string[][] = [];
  let cur: string[] = [];
  let bytes = overhead;
  for (const n of names) {
    const cost = Buffer.byteLength(escapeName(n)) + 1;
    if (cur.length > 0 && bytes + cost > maxBytes) {
      batches.push(cur);
      cur = [];
      bytes = overhead;
    }
    cur.push(n);
    bytes += cost;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

function guessedEntry(
  entry: OrphanEntry,
  edges: GuessEdge[],
  unresolved: UnresolvedEvidence[],
  mentions: MentionEvidence[],
): GuessedEntry {
  return {
    ...entry, edges, unresolved, mentions,
    edgeCount: edges.length, unresolvedCount: unresolved.length, mentionCount: mentions.length,
  };
}

/** Whether a tree-sitter Rust `attribute_item` is exactly `#[cfg(test)]`: the path `cfg` and the one argument `test`. */
function isCfgTest(item: SyntaxNode): boolean {
  const attr = item.namedChild(0);
  if (attr?.type !== 'attribute') return false;
  const head = attr.namedChild(0);
  const args = attr.childForFieldName('arguments');
  const only = args?.namedChildCount === 1 ? args.namedChild(0) : null;
  return head?.type === 'identifier' && head.text === 'cfg' && only?.type === 'identifier' && only.text === 'test';
}

/**
 * The nested-in-test rule: the 1-based line ranges of Rust inline modules
 * declared under `#[cfg(test)]`, from the attribute to the module's closing
 * brace. Read from the tree-sitter Rust parse of `source` (the grammar the
 * indexer uses), so a brace in a string or raw string, or an attribute in a
 * comment, is what the parser says it is. The attribute is an outer one: an
 * `attribute_item` sibling before the `mod_item`, past other attributes and
 * comments. Not matched: a `#[cfg(test)] mod x;` (an out-of-line module, no
 * body here), an inner `#![cfg(test)]`, a compound `cfg(all(test, ...))`.
 * Null when the grammar cannot be loaded or the parse does not finish within
 * the request-time budget (`parseWithinBudget`).
 */
export async function cfgTestRanges(source: string): Promise<{ start: number; end: number }[] | null> {
  let tree: ReturnType<typeof parseWithinBudget>;
  try {
    await loadGrammarsForLanguages(['rust']);
    const parser = getParser('rust');
    tree = parser ? parseWithinBudget(parser, source) : null;
  } catch {
    return null;
  }
  if (!tree) return null;
  try {
    const out: { start: number; end: number }[] = [];
    const stack: SyntaxNode[] = [tree.rootNode];
    while (stack.length > 0) {
      const n = stack.pop() as SyntaxNode;
      if (n.type === 'mod_item' && n.childForFieldName('body')) {
        for (let sib = n.previousNamedSibling; sib; sib = sib.previousNamedSibling) {
          if (sib.type === 'line_comment' || sib.type === 'block_comment') continue;
          if (sib.type !== 'attribute_item') break;
          if (isCfgTest(sib)) {
            out.push({ start: sib.startPosition.row + 1, end: n.endPosition.row + 1 });
            break;
          }
        }
      }
      for (const c of n.namedChildren) if (c) stack.push(c);
    }
    return out.sort((a, b) => a.start - b.start);
  } finally {
    tree.delete();
  }
}

/**
 * The orphan report for `changed` (the `base...HEAD` files) over `store`.
 * Pure over its inputs: git, the file system and ripgrep are reached only
 * through `io` (the Rust grammar `cfgTestRanges` parses with is loaded once,
 * from the package).
 */
export async function findOrphans(
  store: OrphansStore,
  changed: readonly ChangedFile[],
  io: OrphansIO,
): Promise<OrphansReport> {
  let preImageUnread = 0;

  // --- which symbols were added ---------------------------------------------
  const addedRaw: BlastNode[] = [];
  for (const file of changed) {
    if (file.status === 'deleted') continue;
    if (file.status === 'added') {
      addedRaw.push(
        ...store.symbolsOverlapping(file.path, 1, Number.MAX_SAFE_INTEGER).filter((n) => CANDIDATE_KINDS.has(n.kind)),
      );
      continue;
    }
    // `symbolsOverlapping` returns overlap; rule 2 wants the declaration line inside the range.
    const inRange = new Map<string, BlastNode>();
    for (const r of file.ranges) {
      for (const n of store.symbolsOverlapping(file.path, r.start, r.end)) {
        const { start } = spanLines(n.span);
        if (CANDIDATE_KINDS.has(n.kind) && start >= r.start && start <= r.end) inRange.set(n.id, n);
      }
    }
    if (inRange.size === 0) continue;
    const pre = io.preImage(file);
    if (pre === null) {
      preImageUnread += 1;
      addedRaw.push(...inRange.values());
      continue;
    }
    for (const n of inRange.values()) if (!containsWord(pre, n.name)) addedRaw.push(n);
  }

  const nodeCache = new Map<string, OrphanNode>();
  /** `BlastNode`s as `OrphanNode`s, with languages fetched in one batch and cached. */
  function withLanguage(raw: readonly BlastNode[]): OrphanNode[] {
    const missing = raw.filter((n) => !nodeCache.has(n.id)).map((n) => n.id);
    const langs = missing.length > 0 ? store.languages(missing) : new Map<string, string>();
    return raw.map((n) => {
      const hit = nodeCache.get(n.id);
      if (hit) return hit;
      const { start, end } = spanLines(n.span);
      const node: OrphanNode = {
        id: n.id, name: n.name, kind: n.kind, path: n.path, startLine: start, endLine: end, language: langs.get(n.id) ?? '',
      };
      nodeCache.set(n.id, node);
      return node;
    });
  }
  /** Nodes by id, cached. */
  function nodes(ids: readonly string[]): OrphanNode[] {
    const missing = ids.filter((id) => !nodeCache.has(id));
    if (missing.length > 0) withLanguage(store.nodesByIds(missing));
    return ids.map((id) => nodeCache.get(id)).filter((n): n is OrphanNode => n !== undefined);
  }

  const added = withLanguage(addedRaw);
  const addedIds = new Set(added.map((n) => n.id));

  // --- containing types and same-named type groups ----------------------------
  const parentIds = store.parents(added.map((n) => n.id));
  /** S's containing type nodes (via `contains`). */
  const containingTypes = new Map<string, OrphanNode[]>();
  const allParentIds = [...new Set([...parentIds.values()].flat())];
  nodes(allParentIds);
  for (const s of added) {
    containingTypes.set(s.id, nodes(parentIds.get(s.id) ?? []).filter((p) => TYPE_KIND_SET.has(p.kind)));
  }

  // Same-name groups (the Swift extension grouping): every same-language type node sharing a name, for type
  // candidates and for containing types (constructor rule, Swift extensions).
  const groupKeys = new Set<string>();
  const typeNodesNeedingGroups: OrphanNode[] = [
    ...added.filter((n) => TYPE_KIND_SET.has(n.kind)),
    ...[...containingTypes.values()].flat(),
  ];
  for (const t of typeNodesNeedingGroups) groupKeys.add(t.name);
  const groupByKey = new Map<string, OrphanNode[]>();
  if (groupKeys.size > 0) {
    for (const t of store.typesNamed([...groupKeys], TYPE_KINDS)) {
      nodeCache.set(t.id, nodeCache.get(t.id) ?? t);
      const key = `${t.language}\0${t.name}`;
      const at = groupByKey.get(key);
      if (at) at.push(t);
      else groupByKey.set(key, [t]);
    }
  }
  /** The same-name group of a type node (the Swift extension grouping): itself plus every same-language type node of its name. */
  function group(t: OrphanNode): OrphanNode[] {
    const g = groupByKey.get(`${t.language}\0${t.name}`) ?? [];
    return g.some((x) => x.id === t.id) ? g : [t, ...g];
  }

  // --- counted uses -----------------------------------------------------------
  const useTargets = new Set<string>(addedIds);
  for (const t of typeNodesNeedingGroups) for (const g of group(t)) useTargets.add(g.id);
  const usesByTarget = new Map<string, IncomingUse[]>();
  for (const u of store.incomingUses([...useTargets])) {
    const at = usesByTarget.get(u.target);
    if (at) at.push(u);
    else usesByTarget.set(u.target, [u]);
  }
  /** Incoming uses of one node, minus those from itself or from inside its own span. */
  function ownCounted(n: OrphanNode): IncomingUse[] {
    return (usesByTarget.get(n.id) ?? []).filter(
      (u) =>
        u.source !== n.id &&
        !(u.sourcePath === n.path && u.sourceStart >= n.startLine && u.sourceEnd <= n.endLine),
    );
  }
  /** Counted uses of S: its own, or for a type, those of its whole same-name group. */
  function counted(n: OrphanNode): IncomingUse[] {
    if (!TYPE_KIND_SET.has(n.kind)) return ownCounted(n);
    return group(n).flatMap(ownCounted);
  }

  // --- implementation check (indexed conformances, external table) ------------
  const conformanceCache = new Map<string, string[]>();
  const memberCache = new Map<string, Set<string>>();
  const sourceCache = new Map<string, string[] | null>();
  function conformancesOf(ids: readonly string[]): void {
    const missing = ids.filter((id) => !conformanceCache.has(id));
    if (missing.length === 0) return;
    const got = store.conformances(missing);
    for (const id of missing) conformanceCache.set(id, got.get(id) ?? []);
  }
  function membersOf(ids: readonly string[]): void {
    const missing = ids.filter((id) => !memberCache.has(id));
    if (missing.length === 0) return;
    const got = store.memberNames(missing);
    for (const id of missing) memberCache.set(id, got.get(id) ?? new Set());
  }
  function lines(path: string): string[] | null {
    if (!sourceCache.has(path)) {
      const text = io.source(path);
      sourceCache.set(path, text === null ? null : text.split(/\r?\n/));
    }
    return sourceCache.get(path) ?? null;
  }
  /** Whether T's source span holds `name` as a whole word (one file read per path, cached). */
  function spanMentions(t: OrphanNode, name: string): boolean {
    const ls = lines(t.path);
    if (!ls) return false;
    return containsWord(ls.slice(Math.max(0, t.startLine - 1), t.endLine).join('\n'), name);
  }
  /** S's containing types for the indexed-conformance check and the external-conformance table: via `contains`, plus for Swift every same-named type node. */
  function conformingTypes(s: OrphanNode): OrphanNode[] {
    const out = new Map<string, OrphanNode>();
    for (const t of containingTypes.get(s.id) ?? []) {
      out.set(t.id, t);
      if (t.language === 'swift') for (const g of group(t)) out.set(g.id, g);
    }
    return [...out.values()];
  }
  /** The indexed-conformance check: an indexed type reached over implements/extends declares S's name. */
  function implementsIndexed(s: OrphanNode, starts: readonly OrphanNode[]): boolean {
    const seen = new Set(starts.map((t) => t.id));
    let frontier = starts.map((t) => t.id);
    for (let depth = 0; depth < CONFORMANCE_DEPTH && frontier.length > 0; depth++) {
      conformancesOf(frontier);
      const next = [...new Set(frontier.flatMap((id) => conformanceCache.get(id) ?? []))].filter((id) => !seen.has(id));
      if (next.length === 0) return false;
      for (const id of next) seen.add(id);
      membersOf(next);
      for (const t of nodes(next)) {
        if (memberCache.get(t.id)?.has(s.name) || spanMentions(t, s.name)) return true;
      }
      frontier = next;
    }
    return false;
  }

  // --- classify -----------------------------------------------------------------
  const report: OrphansReport = {
    added: added.length,
    orphans: [],
    guessed: [],
    excluded: { test: 0, implementation: 0, constructor: 0, entry: 0 },
    preImageUnread,
    searchUnread: 0,
  };
  /** A candidate with no counted use, checked by the unresolved-reference and text-mention checks after the loop. */
  interface Suspect { s: OrphanNode; entry: OrphanEntry }
  const suspects: Suspect[] = [];
  const memberCandidates = added.filter((s) => MEMBER_KINDS.has(s.kind));
  const externalByType = store.externalConformances([
    ...new Set(memberCandidates.flatMap((s) => conformingTypes(s).map((t) => t.id))),
  ]);

  /**
   * Whether `n`'s start line, or the attribute / comment lines just above it, match `attr` (the
   * test and entry-point rules). A comment line (`COMMENT_LINE`) is walked over, never matched.
   * Null `attr` (no attribute in this language) is false without reading the file.
   */
  function hasAttribute(n: { path: string; startLine: number }, attr: RegExp | null): boolean {
    if (attr === null) return false;
    const ls = lines(n.path);
    if (!ls) return false;
    const marks = (l: string): boolean => !COMMENT_LINE.test(l) && attr.test(l);
    const at = n.startLine - 1;
    if (marks(ls[at] ?? '')) return true;
    for (let i = at - 1; i >= 0 && i >= at - ATTRIBUTE_LOOKBACK; i--) {
      const l = ls[i] ?? '';
      if (!ATTRIBUTE_OR_COMMENT.test(l)) break;
      if (marks(l)) return true;
    }
    return false;
  }
  /**
   * The test rule by name or attribute (`language` picks the attribute, `testAttributeFor`): also
   * the test a symbol enclosing S is held to in the nested-in-test rule.
   */
  function isTestByMark(n: { name: string; path: string; startLine: number }, language: string): boolean {
    return TEST_NAME.test(n.name) || hasAttribute(n, testAttributeFor(language));
  }
  /**
   * The nested-in-test rule's Rust `#[cfg(test)]` module ranges, one parse per
   * Rust file holding an added symbol, read before the classify loop. A file that
   * cannot be read or parsed has none, so nothing in it is excluded by this rule.
   */
  const cfgTestByPath = new Map<string, { start: number; end: number }[]>();
  for (const p of new Set(added.filter((s) => s.language === 'rust').map((s) => s.path))) {
    const ls = lines(p);
    cfgTestByPath.set(p, ls ? ((await cfgTestRanges(ls.join('\n'))) ?? []) : []);
  }
  function isTest(s: OrphanNode): boolean {
    if (isTestPath(s.path) || isTestByMark(s, s.language)) return true;
    // Nested-in-test rule: inside a test-marked symbol of the same file (one overlap query per
    // candidate), whose attributes are read as S's language: one file, one language.
    for (const n of store.symbolsOverlapping(s.path, s.startLine, s.endLine)) {
      if (n.id === s.id) continue;
      const { start, end } = spanLines(n.span);
      const encloses = start <= s.startLine && end >= s.endLine && (start < s.startLine || end > s.endLine);
      if (encloses && isTestByMark({ name: n.name, path: n.path, startLine: start }, s.language)) return true;
    }
    if (s.language === 'rust') {
      return (cfgTestByPath.get(s.path) ?? []).some((r) => r.start <= s.startLine && r.end >= s.endLine);
    }
    return false;
  }

  /** Entry-point rule: a Swift type declared under `@main`, cached by id. */
  const mainTypeCache = new Map<string, boolean>();
  function isMainType(t: OrphanNode): boolean {
    let v = mainTypeCache.get(t.id);
    if (v === undefined) {
      v = hasAttribute(t, t.language === 'swift' ? MAIN_ATTRIBUTE : null);
      mainTypeCache.set(t.id, v);
    }
    return v;
  }
  function isEntry(s: OrphanNode): boolean {
    if (TYPE_KIND_SET.has(s.kind)) return isMainType(s);
    if (s.name !== ENTRY_NAME) return false;
    if (s.kind === 'function' && !nodes(parentIds.get(s.id) ?? []).some((p) => CALLABLE_KINDS.has(p.kind))) return true;
    return MEMBER_KINDS.has(s.kind) && conformingTypes(s).some(isMainType);
  }

  for (const s of added) {
    if (isTest(s)) {
      report.excluded.test += 1;
      continue;
    }
    if (isEntry(s)) {
      report.excluded.entry += 1;
      continue;
    }
    let external: string[] | undefined;
    if (MEMBER_KINDS.has(s.kind)) {
      const types = conformingTypes(s);
      // Requirement rule: a requirement of a used interface / trait / protocol.
      if (containingTypes.get(s.id)?.some((t) => REQUIREMENT_CONTAINER_KINDS.has(t.kind) && counted(t).length > 0)) {
        report.excluded.implementation += 1;
        continue;
      }
      if (types.length > 0 && implementsIndexed(s, types)) {
        report.excluded.implementation += 1;
        continue;
      }
      const refs = [...new Set(types.flatMap((t) => externalByType.get(t.id) ?? []).map(lastSegment))].sort(cmp);
      if (refs.length > 0) {
        const table = EXTERNAL_REQUIREMENTS[s.language] ?? {};
        if (refs.some((r) => table[r]?.includes(s.name))) {
          report.excluded.implementation += 1;
          continue;
        }
        external = refs;
      }
    }
    if (CONSTRUCTOR_NAMES.has(s.name) && (containingTypes.get(s.id) ?? []).some((t) => counted(t).length > 0)) {
      report.excluded.constructor += 1;
      continue;
    }
    const uses = counted(s);
    const entry: OrphanEntry = {
      id: s.id, name: s.name, kind: s.kind, path: s.path, span: `L${s.startLine}-L${s.endLine}`,
      ...(external ? { externalConformances: external } : {}),
    };
    if (uses.length === 0) {
      suspects.push({ s, entry });
    } else if (uses.every((u) => isGuess(u.kind, u.metadata, u.sourcePath, u.targetPath))) {
      // Each edge's own target file, not S's: a type's uses come from its whole same-name group.
      const edges = uses
        .map((u): GuessEdge => ({
          source: u.source,
          sourceName: u.sourceName,
          sourcePath: u.sourcePath,
          line: u.line,
          kind: u.kind,
          resolvedBy: typeof u.metadata.resolvedBy === 'string' ? u.metadata.resolvedBy : null,
          confidence: typeof u.metadata.confidence === 'number' ? u.metadata.confidence : null,
        }))
        .sort((a, b) => cmp(a.sourcePath, b.sourcePath) || a.line - b.line || cmp(a.source, b.source));
      report.guessed.push(guessedEntry(entry, edges, [], []));
    }
  }

  // --- unresolved-reference check: failed references naming a suspect ---------
  /** Whether a position in `path` from `start` to `end` lies inside S's own span. */
  const insideOwn = (s: OrphanNode, path: string, start: number, end: number): boolean =>
    path === s.path && start >= s.startLine && end <= s.endLine;
  let left: Suspect[] = suspects;
  if (left.length > 0) {
    const refsByName = new Map<string, FailedRef[]>();
    for (const r of store.failedRefsNamed([...new Set(left.map((x) => x.s.name))])) {
      const at = refsByName.get(r.nameTail);
      if (at) at.push(r);
      else refsByName.set(r.nameTail, [r]);
    }
    const next: Suspect[] = [];
    for (const x of left) {
      const lang = languageKey(x.s.language);
      const containerNames = (containingTypes.get(x.s.id) ?? []).map((t) => t.name);
      const rank = (u: UnresolvedEvidence): number => refRank(u.name, u.path, x.s, containerNames);
      const refs = (refsByName.get(x.s.name) ?? [])
        .filter((r) => languageKey(r.language) === lang)
        .filter((r) => r.fromNode !== x.s.id && !insideOwn(x.s, r.fromPath, r.fromStart, r.fromEnd))
        .map((r): UnresolvedEvidence => ({ name: r.referenceName, kind: r.referenceKind, path: r.path, line: r.line }))
        .sort((a, b) => rank(a) - rank(b) || cmp(a.path, b.path) || a.line - b.line || cmp(a.name, b.name));
      if (refs.length > 0) report.guessed.push(guessedEntry(x.entry, [], refs, []));
      else next.push(x);
    }
    left = next;
  }

  // --- text-mention check: mentions of a suspect outside its own span ---------
  const searchable = left.filter((x) => IDENTIFIER_NAME.test(x.s.name));
  const mentionKeys = new Map<string, Set<string>>();
  const mentions = new Map<string, MentionEvidence[]>();
  /** The searchable suspects by name. */
  const byName = new Map<string, Suspect[]>();
  for (const x of searchable) {
    const at = byName.get(x.s.name);
    if (at) at.push(x);
    else byName.set(x.s.name, [x]);
  }
  /** Whether some suspect named `name` still has no mention. */
  const lacking = (name: string): boolean => (byName.get(name) ?? []).some((x) => !mentions.has(x.s.id));
  /** A hit naming `name`: a mention for each suspect of that name whose own span does not hold it. */
  function mention(name: string, h: TextHit): void {
    for (const x of byName.get(name) ?? []) {
      if (insideOwn(x.s, h.path, h.line, h.line)) continue;
      const keys = mentionKeys.get(x.s.id) ?? new Set<string>();
      const key = `${h.path}\0${h.line}`;
      if (keys.has(key)) continue;
      keys.add(key);
      mentionKeys.set(x.s.id, keys);
      const at = mentions.get(x.s.id);
      if (at) at.push({ path: h.path, line: h.line });
      else mentions.set(x.s.id, [{ path: h.path, line: h.line }]);
    }
  }
  /**
   * One search for `names`, keeping at most `maxHits` hits; true when it dropped
   * some. With one name every hit is that name's (ripgrep matched it); with
   * several, the file's own line (not the search's possibly cut copy) says which.
   * Its unread-file count raises `report.searchUnread` to it (the most, not the sum:
   * each run searches every indexed file).
   */
  async function searchOnce(names: readonly string[], maxHits: number): Promise<boolean> {
    const pattern = mentionPattern(names);
    if (Buffer.byteLength(pattern) > MENTION_PATTERN_BYTES) {
      throw new MentionSearchIncompleteError(
        `a name is too long to search for (${Buffer.byteLength(pattern)} bytes of pattern, over ${MENTION_PATTERN_BYTES}): ` +
        `"${(names[0] ?? '').slice(0, 40)}…" cannot be checked for text mentions, so orphans will not call it orphaned`,
      );
    }
    const { hits, truncated, unread } = await io.search(pattern, maxHits);
    report.searchUnread = Math.max(report.searchUnread, unread);
    const only = names.length === 1 ? names[0] : undefined;
    if (only !== undefined) {
      for (const h of hits) mention(only, h);
    } else {
      const named = new RegExp(`(?<!${IDENT})(?:${names.map(escapeName).join('|')})(?!${IDENT})`, 'gu');
      for (const h of hits) {
        const lineText = lines(h.path)?.[h.line - 1] ?? h.text;
        for (const m of new Set([...lineText.matchAll(named)].map((x) => x[0]))) mention(m, h);
      }
    }
    return truncated;
  }
  /**
   * At most how many of a name-alone search's hits can lie inside `x`'s own span:
   * the span's lines that contain the name at all (a superset of ripgrep's word
   * matches, one hit per line), or every line of the span when the file cannot be read.
   */
  function ownHitBound(x: Suspect): number {
    const ls = lines(x.s.path);
    if (!ls) return x.s.endLine - x.s.startLine + 1;
    return ls.slice(Math.max(0, x.s.startLine - 1), x.s.endLine).filter((l) => l.includes(x.s.name)).length;
  }
  // Batched runs. A batch whose run dropped hits is searched again for its names still
  // without a mention while that settles some; a batch that settles none is stuck.
  let pending = [...byName.keys()];
  const stuck: string[] = [];
  while (pending.length > 0) {
    const again: string[] = [];
    for (const batch of mentionBatches(pending)) {
      if (!(await searchOnce(batch, MENTION_SEARCH_CAP))) continue;
      const still = batch.filter(lacking);
      (still.length < batch.length ? again : stuck).push(...still);
    }
    pending = again;
  }
  // Name-alone runs for the stuck names. Keeping the cap plus the most hits any one
  // unmentioned suspect's own span can hold, a run that still drops hits has kept a line
  // outside each such span, so a suspect left without a mention means the files changed
  // under the search.
  for (const name of stuck) {
    const own = Math.max(0, ...(byName.get(name) ?? []).filter((x) => !mentions.has(x.s.id)).map(ownHitBound));
    if ((await searchOnce([name], MENTION_SEARCH_CAP + own)) && lacking(name)) {
      throw new MentionSearchIncompleteError(
        `the text-mention search for "${name}" dropped hits past its cap and kept none outside the symbol's own span ` +
        '(a file changed during the run?); orphans will not call it orphaned without that check — run it again',
      );
    }
  }
  for (const x of left) {
    const found = mentions.get(x.s.id);
    if (found) {
      found.sort((a, b) => cmp(a.path, b.path) || a.line - b.line);
      report.guessed.push(guessedEntry(x.entry, [], [], found));
    } else {
      report.orphans.push(x.entry);
    }
  }

  const start = (e: OrphanEntry): number => spanLines(e.span).start;
  const byPosition = (a: OrphanEntry, b: OrphanEntry): number => cmp(a.path, b.path) || start(a) - start(b) || cmp(a.id, b.id);
  report.orphans.sort(byPosition);
  report.guessed.sort(byPosition);
  return report;
}
