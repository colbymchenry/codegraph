/**
 * Dead code and islands — one derivation of "nothing in this repository
 * reaches here".
 *
 * The graph can answer that question exactly, and that is the problem: the
 * exact answer is *no incoming edge*, and a symbol with no incoming edge is not
 * the same thing as a symbol nobody uses. Reflection calls it. A framework
 * registers it by name. A test file that was never indexed imports it. The
 * resolver saw the name and could not follow it. So the honest product of this
 * module is two things at once — a list, and everything the list could not see.
 *
 * ## The shape of the claim
 *
 * `unreferenced` is a fact: no edge in the index, other than the `contains`
 * edge from whatever holds it, points at this symbol. `dead` is an inference on
 * top of that fact, and every step of the inference is subtractive — a
 * candidate is dropped from the list the moment there is any reason to believe
 * something outside the graph reaches it:
 *
 * - it is **exported** (something outside this repository may import it);
 * - it lives in a **test** or a **generated** file (not code anyone deletes by
 *   hand);
 * - it is **abstract** or declared on an interface (a declaration is dispatched
 *   to, never called);
 * - it is **decorated** (`@app.route`, `@Component`, `@EventHandler`) — a
 *   decorator is a registration, and the framework that reads it is not in the
 *   graph. Seen as the symbol's own outgoing `decorates` edge, which is where
 *   the engine records it; `node.decorators` is only populated by a couple of
 *   languages and is checked as well rather than instead;
 * - it **overrides** a member an ancestor declares (calls land on the ancestor;
 *   see {@link overrideCandidates} for why an ancestor we cannot read counts
 *   the same way);
 * - it has a name the language calls by itself (`constructor`, `__enter__`,
 *   `main`);
 * - it sits in a **vendored** directory (`vendor/`, `third_party/`,
 *   `node_modules/` — code the repository carries but does not own);
 * - it is in a **test scope** the path does not reveal — a Rust
 *   `#[cfg(test)] mod tests`, a nested `Tests` namespace;
 * - it is in a **component file** whose markup the index reads for calls but
 *   not for references, so a handler passed as `{onkeydown}` is invisible;
 * - it is in a file **nothing in the index reaches**. Then "nothing references
 *   this symbol" is a restatement of "we cannot see how this file is wired",
 *   not a finding about the symbol — and it is the map, not this list, that
 *   says so: a file no one reaches is an island, and islands are drawn there;
 * - the index holds an **unresolved reference** to its name. A `failed` row in
 *   `unresolved_refs` is the resolver's own record of a reference it could not
 *   follow, and a symbol whose name we failed to follow cannot be called
 *   unreferenced.
 * - **another symbol of the same name IS referenced.** This is the one that
 *   matters most and the one nothing else would catch. `CodeGraph.getTopRouteFile`
 *   calls `this.queries.getTopRouteFile()`; the resolver prefers a same-name
 *   definition in the call site's own file, so the edge lands on the caller
 *   itself and the real target is left with nothing. From the edge table,
 *   "nobody calls this" and "the resolver picked the twin" are the same
 *   picture — so the claim is not made about either;
 * - it is declared in a **header** (`.h`, `.hpp`, `.d.ts`, `.pyi`): a header IS
 *   the export surface, and the reference to it is an `#include` the resolver
 *   does not follow to the declaration;
 * - it is in a language this index records **no export marker** for. The
 *   exported filter is the strongest one here, and for Rust (`pub` is not
 *   recorded) or Python and C (no such concept at all) it silently does
 *   nothing — so the index is asked, per language, whether it ran;
 * - **its own file writes the name more than once.** The last rule, and the
 *   only one that is not a graph query. Everything above assumes the edge
 *   table is complete; it is not, and the gaps do not announce themselves —
 *   `this.handleMessage.bind(this)` is a value reference the extractor does not
 *   record, and a call inside an object-literal initialiser is another. Both
 *   leave the name written twice in one file and no edge at all. So before the
 *   claim is made, the identifier is counted in the file itself AND in every
 *   file the index says depends on it — written once, in its own declaration,
 *   nothing that can reach it writes it down; written twice, we simply did not
 *   see the second one.
 *
 * Every subtraction is counted. {@link DeadCodeReport.excluded} is not
 * diagnostics — it is the sentence under the list ("47 exported, 12 overriding
 * an ancestor…"), because a list of eight rows drawn from four thousand
 * candidates means something different from a list of eight drawn from nine.
 *
 * ## Islands
 *
 * The other half of the task, a *module* nothing depends on, is not computed
 * here: it falls straight out of the map's own link set (a module with no
 * incoming link), and the map's layout is already a pure function in the
 * viewer. Computing it a second time on this side would be a second answer to
 * a question the map has already answered. See `ui/src/lib/map-model.ts`.
 *
 * Everything here is query-time and read-only.
 */

import fs from 'fs';
import path from 'path';
import type CodeGraph from '../index';
import type { Node, NodeKind } from '../types';
import { isTestFile } from '../search/query-utils';

// =============================================================================
// Caps and defaults
// =============================================================================

/**
 * Kinds asked about by default.
 *
 * Callables and types, and nothing else. `variable`/`constant`/`field` are out
 * deliberately: a value's uses are recorded as `references` edges, and that
 * coverage is the most language-dependent thing in the resolver — a default
 * that included them would produce a list whose truthfulness varied by which
 * language the reader happened to be looking at.
 */
export const DEAD_CODE_KINDS: readonly NodeKind[] = [
  'function',
  'method',
  'class',
  'component',
  'interface',
  'struct',
  'trait',
  'protocol',
  'enum',
  'union',
  'type_alias',
];

/** Kinds a `kinds=` request may ask for. Anything else is a caller bug. */
export const DEAD_CODE_ALLOWED_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  ...DEAD_CODE_KINDS,
  'variable',
  'constant',
  'property',
  'field',
  'enum_member',
  'namespace',
  'module',
]);

/**
 * Candidates pulled out of SQL before any exclusion runs.
 *
 * High enough that no real repository reaches it with the default kinds (this
 * index produces ~1 400), and bounded so that a half-indexed monorepo cannot
 * turn one screen into a scan of a million rows. When it bites,
 * {@link DeadCodeReport.bounded} says so.
 */
export const MAX_DEAD_CODE_CANDIDATES = 20000;

/** Levels walked up looking for an ancestor that declares the same member. */
export const MAX_OVERRIDE_ANCESTOR_DEPTH = 8;

/**
 * Files read for the corroboration pass, and the biggest one read.
 *
 * The pass runs over the survivors only — everything cheap has already fired —
 * so on this index it reads a few dozen files. The caps are a backstop against
 * a repository whose survivors span a thousand files or include a generated
 * megabyte. A file skipped for either reason counts as NOT corroborated, which
 * drops the row: the safe direction is always the one that says less.
 */
export const MAX_CORROBORATION_FILES = 600;
export const MAX_CORROBORATION_BYTES = 2_000_000;

/** Kinds that can carry members, i.e. whose ancestors are worth walking. */
const CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'class',
  'interface',
  'struct',
  'trait',
  'protocol',
  'enum',
  'union',
  'type_alias',
]);

/** Container kinds whose members are declarations, never call targets. */
const DECLARATION_CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'interface',
  'trait',
  'protocol',
]);

/** Member kinds an override can be declared on. */
const OVERRIDABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'method',
  'function',
  'property',
  'field',
]);

/**
 * Names a language or a runtime calls without anything in the source naming
 * them.
 *
 * Kept short on purpose. The temptation is a per-language table of every
 * lifecycle hook ever written, which would be wrong twice over — it would go
 * stale, and it would hide real dead code behind a name coincidence. The
 * entries below are the ones where the *language itself* does the calling, so
 * no source file could name them even in principle. Framework hooks are caught
 * by the decorator and override rules instead, which are structural.
 */
const IMPLICIT_ENTRY_NAMES: ReadonlySet<string> = new Set([
  'constructor',
  'main',
  'init',
  'deinit',
  'finalize',
  'destructor',
  'dispose',
  'drop',
  'default',
  'tostring',
  'equals',
  'gethashcode',
  'hashcode',
]);

/**
 * Qualified-name segments that mean "inside a test scope the file path does not
 * reveal" — a Rust `#[cfg(test)] mod tests`, a nested `Tests` class in C#, a
 * Go `TestMain` helper block. `isTestFile` only reads paths, and an in-file test
 * module is invisible to it.
 */
const TEST_SCOPE_SEGMENTS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'testing',
]);

/**
 * Languages whose files are markup with a script block inside them.
 *
 * The extractors for these read the `<script>` region properly and scan the
 * template for CALLS — but a handler passed by reference (`{onkeydown}`,
 * `@click="submit"`) is a reference, not a call, and it is not extracted. Every
 * event handler in every component would therefore head this list. The index
 * cannot tell a handler wired in markup from one nobody uses, so it does not
 * guess.
 */
const MARKUP_HOST_LANGUAGES: ReadonlySet<string> = new Set([
  'svelte',
  'vue',
  'astro',
  'liquid',
  'html',
  'razor',
  'twig',
  'blade',
  'erb',
  'handlebars',
]);

/**
 * Extensions whose contents are declarations for somebody else.
 *
 * A C header is the translation unit's export surface: everything in it exists
 * to be `#include`d, and the resolver does not follow an include to the
 * declaration it lands on. `.d.ts` and `.pyi` are the same idea in TypeScript
 * and Python. Treating these as exported is not a heuristic — it is what the
 * file is for.
 */
const HEADER_EXTENSIONS: ReadonlyArray<string> = [
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.h++',
  '.inc',
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.pyi',
  '.pxd',
];

/** Python and Ruby call these by protocol: `__enter__`, `__iter__`, `__init__`. */
const DUNDER = /^__[a-z0-9_]+__$/i;

/**
 * Directory names that mean "this code is carried, not written here".
 *
 * Vendored third-party source is the second-largest source of noise after name
 * ambiguity, and it is noise of a particular kind: the code IS reached, by a
 * build system or a runtime that is not in the index at all (a tree-sitter
 * scanner is called through a generated symbol table; a vendored library is
 * called by whatever links it). Matched as a whole path segment, so
 * `src/vendored-parser.ts` is not caught by `vendor`.
 */
const VENDOR_SEGMENTS: ReadonlySet<string> = new Set([
  'vendor',
  'vendored',
  'third_party',
  'third-party',
  'thirdparty',
  'external',
  'externals',
  'node_modules',
  'bower_components',
  'site-packages',
  'godeps',
  'pods',
  '.venv',
  'venv',
]);

// =============================================================================
// Shapes
// =============================================================================

/** One symbol nothing reaches, and what it takes with it. */
export interface DeadCodeEntry {
  node: Node;
  /**
   * Members that are themselves unreferenced and live inside {@link node}.
   *
   * A class nobody instantiates takes its methods with it, and listing all
   * eleven of them as siblings would turn one finding into eleven. They are
   * folded in here instead and reported as a count.
   */
  members: Node[];
  /** Source lines the entry spans, members included (they are inside it). */
  lines: number;
  /**
   * The symbol is exported. Only ever true when the caller asked for exported
   * symbols — and then it is the row's own caveat, because an exported symbol
   * is reachable from outside the index by definition.
   */
  exported: boolean;
}

/** How many candidates each rule removed, in the order the rules ran. */
export interface DeadCodeExclusions {
  /** In a file that looks like test or fixture code. */
  tests: number;
  /** In a tool-generated file. */
  generated: number;
  /** Exported, or declared in a header — reachable from outside this index. */
  exported: number;
  /**
   * In a language this index records no export marker for, so nothing here can
   * be told apart from that language's public surface.
   */
  exportsUnknown: number;
  /** Abstract, or a member of an interface / trait / protocol. */
  declarations: number;
  /** Carries a decorator, so a framework registers it. */
  decorated: number;
  /** Overrides a member an ancestor declares, or an ancestor we cannot read. */
  overriding: number;
  /** Named something the language calls by itself. */
  implicit: number;
  /** In a vendored directory — carried code, reached by something outside the index. */
  vendored: number;
  /** In a test scope the file path does not reveal (a Rust `mod tests`). */
  testScope: number;
  /** In a component file whose markup can reference a symbol invisibly. */
  markup: number;
  /** In a file nothing in the index reaches — an island, drawn on the map. */
  unreachableFile: number;
  /** The index holds an unresolved reference to this name. */
  unresolvedName: number;
  /** Another symbol of the same name IS referenced, so the resolver may have picked it. */
  ambiguousName: number;
  /** Its own file writes the name more than once, so something uses it there. */
  mentioned: number;
  /** Its file could not be read, so the mention count could not be checked. */
  unreadable: number;
  /** Folded into a container that is itself on the list. */
  nested: number;
}

export interface DeadCodeReport {
  /** Ranked, capped. */
  entries: DeadCodeEntry[];
  /** Entries before {@link DeadCodeQuery.limit} — always the real number. */
  total: number;
  /** Symbols with no incoming reference at all, before any exclusion ran. */
  candidates: number;
  excluded: DeadCodeExclusions;
  /** The kinds actually asked about. */
  kinds: NodeKind[];
  /** Exported symbols were included, so every row carries the outside-reach caveat. */
  includeExported: boolean;
  /** The candidate scan stopped at {@link MAX_DEAD_CODE_CANDIDATES}. */
  bounded: boolean;
  /**
   * Every surviving row was checked against its own file's text — the rule that
   * covers the edges the extractor never recorded. False when no reader was
   * available, and then the list is weaker than it looks.
   */
  corroborated: boolean;
}

export interface DeadCodeQuery {
  kinds?: readonly NodeKind[];
  /** Include symbols something outside the index could import. Default false. */
  includeExported?: boolean;
  /** Include symbols in test files. Default false. */
  includeTests?: boolean;
  /** Include symbols in tool-generated files. Default false. */
  includeGenerated?: boolean;
  /** Entries returned. `total` stays the real count. */
  limit?: number;
  /**
   * How to read a project-relative source file, for the corroboration pass.
   *
   * Injected rather than assumed so that a caller with a read chokepoint — the
   * viewer's API refuses any path outside the project before opening it — keeps
   * its own rule. Return `null` for anything unreadable. Omitted entirely means
   * the default reader, which resolves against the project root; passing `null`
   * turns the pass off, and {@link DeadCodeReport.corroborated} then says so.
   */
  readSource?: ((filePath: string) => string | null) | null;
}

// =============================================================================
// The report
// =============================================================================

/**
 * The dead code report: unreferenced symbols, minus every reason to doubt it,
 * plus a count of every doubt.
 */
export function buildDeadCodeReport(cg: CodeGraph, query: DeadCodeQuery = {}): DeadCodeReport {
  const kinds = normalizeKinds(query.kinds);
  const includeExported = query.includeExported === true;
  const includeTests = query.includeTests === true;
  const includeGenerated = query.includeGenerated === true;
  const limit = Math.max(1, query.limit ?? 200);
  const readSource =
    query.readSource === undefined ? defaultSourceReader(cg) : query.readSource;

  const excluded: DeadCodeExclusions = {
    tests: 0,
    generated: 0,
    exported: 0,
    exportsUnknown: 0,
    declarations: 0,
    decorated: 0,
    overriding: 0,
    implicit: 0,
    vendored: 0,
    testScope: 0,
    markup: 0,
    unreachableFile: 0,
    unresolvedName: 0,
    ambiguousName: 0,
    mentioned: 0,
    unreadable: 0,
    nested: 0,
  };

  const raw = cg.getUnreferencedNodes(kinds, MAX_DEAD_CODE_CANDIDATES + 1);
  const bounded = raw.length > MAX_DEAD_CODE_CANDIDATES;
  const candidates = bounded ? raw.slice(0, MAX_DEAD_CODE_CANDIDATES) : raw;

  // Asking the index whether the exported filter can run at all, per language,
  // over the handful of languages the candidates are actually in. Skipped when
  // the caller has already accepted outside-reachability by asking for exported
  // symbols.
  const languagesWithExports = includeExported
    ? new Set<string>()
    : cg.getLanguagesWithExports(candidates.map((row) => row.node.language));

  // ---- the cheap, per-row rules -------------------------------------------
  const surviving: Array<{ node: Node; generated: boolean }> = [];
  for (const row of candidates) {
    const { node } = row;
    if (!includeTests && isTestFile(node.filePath)) {
      excluded.tests += 1;
      continue;
    }
    if (!includeGenerated && row.generated) {
      excluded.generated += 1;
      continue;
    }
    if (!includeExported && (node.isExported || isHeaderFile(node.filePath))) {
      excluded.exported += 1;
      continue;
    }
    if (!includeExported && !languagesWithExports.has(node.language)) {
      excluded.exportsUnknown += 1;
      continue;
    }
    if (node.isAbstract) {
      excluded.declarations += 1;
      continue;
    }
    if (isImplicitEntryName(node.name)) {
      excluded.implicit += 1;
      continue;
    }
    if (isVendoredPath(node.filePath)) {
      excluded.vendored += 1;
      continue;
    }
    if (!includeTests && isTestScope(node.qualifiedName)) {
      excluded.testScope += 1;
      continue;
    }
    if (MARKUP_HOST_LANGUAGES.has(node.language)) {
      excluded.markup += 1;
      continue;
    }
    surviving.push(row);
  }

  // ---- the rules that need the graph --------------------------------------
  // A `decorates` edge runs FROM the decorated symbol to the decorator, so
  // this is an outgoing-edge question, not something the candidate query could
  // have answered.
  const decorated = new Set(
    cg
      .getOutgoingEdgesFrom(
        surviving.map((row) => row.node.id),
        ['decorates']
      )
      .map((edge) => edge.source)
  );
  const containers = containersOf(cg, surviving.map((row) => row.node));
  const overriding = overrideCandidates(cg, surviving.map((row) => row.node), containers);
  // One batched count for every file still in play. A file nothing reaches is
  // an island: its symbols' zero fan-in describes the file, not the symbol.
  const unreachableFiles = filesNothingReaches(cg, surviving.map((row) => row.node.filePath));
  const reachable = surviving.filter((row) => {
    if (!unreachableFiles.has(row.node.filePath)) return true;
    excluded.unreachableFile += 1;
    return false;
  });
  surviving.length = 0;
  surviving.push(...reachable);

  const names = surviving.map((row) => row.node.name);
  const unresolved = cg.getUnresolvedNamesAmong(names);
  const ambiguousNames = cg.getAmbiguousReferencedNames(names);

  const kept: Array<{ node: Node; generated: boolean }> = [];
  for (const row of surviving) {
    if (decorated.has(row.node.id) || (row.node.decorators?.length ?? 0) > 0) {
      excluded.decorated += 1;
      continue;
    }
    const container = containers.get(row.node.id);
    if (container && DECLARATION_CONTAINER_KINDS.has(container.kind)) {
      excluded.declarations += 1;
      continue;
    }
    if (overriding.has(row.node.id)) {
      excluded.overriding += 1;
      continue;
    }
    if (unresolved.has(row.node.name)) {
      excluded.unresolvedName += 1;
      continue;
    }
    if (ambiguousNames.has(row.node.name)) {
      excluded.ambiguousName += 1;
      continue;
    }
    kept.push(row);
  }

  // ---- the file's own text has the last word -------------------------------
  // Everything above is a graph query, and the graph is what has the gaps. This
  // is the only rule that can see a reference the extractor never recorded.
  const confirmed: Array<{ node: Node; generated: boolean }> = [];
  if (readSource) {
    const sources = new Map<string, string | null>();
    const read = (file: string): string | null => {
      if (!sources.has(file)) {
        sources.set(file, sources.size >= MAX_CORROBORATION_FILES ? null : readSource(file));
      }
      return sources.get(file) ?? null;
    };
    // The set to search is the declaring file plus everything the index says
    // reaches into it — the same set a call could have come from. Computed once
    // per file, not once per candidate.
    const scopes = new Map<string, string[]>();
    for (const row of kept) {
      const file = row.node.filePath;
      if (!scopes.has(file)) scopes.set(file, [file, ...cg.getFileDependents(file)]);
    }

    for (const row of kept) {
      const scope = scopes.get(row.node.filePath) ?? [row.node.filePath];
      let own: string | null = null;
      let mentions = 0;
      for (const file of scope) {
        const source = read(file);
        if (file === row.node.filePath) own = source;
        if (source === null) continue;
        mentions += mentionCount(source, row.node.name, 2 - mentions);
        if (mentions >= 2) break;
      }
      // Its OWN file has to be readable: the declaration itself is one of the
      // two mentions, so an unreadable declaring file makes the count meaningless.
      if (own === null) {
        excluded.unreadable += 1;
        continue;
      }
      if (mentions >= 2) {
        excluded.mentioned += 1;
        continue;
      }
      confirmed.push(row);
    }
  } else {
    confirmed.push(...kept);
  }

  // ---- fold members into a container that is itself dead -------------------
  const keptIds = new Set(confirmed.map((row) => row.node.id));
  const entries = new Map<string, DeadCodeEntry>();
  const pending: Array<{ node: Node; containerId: string }> = [];
  for (const row of confirmed) {
    const container = containers.get(row.node.id);
    if (container && keptIds.has(container.id)) {
      pending.push({ node: row.node, containerId: container.id });
      excluded.nested += 1;
      continue;
    }
    entries.set(row.node.id, {
      node: row.node,
      members: [],
      lines: Math.max(1, row.node.endLine - row.node.startLine + 1),
      exported: row.node.isExported === true,
    });
  }
  for (const member of pending) {
    // A member whose container was itself folded away (a dead class inside a
    // dead class) has no entry to hang off; it was still counted as nested, so
    // it is not silently missing from the totals.
    entries.get(member.containerId)?.members.push(member.node);
  }
  for (const entry of entries.values()) {
    entry.members.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
  }

  // Biggest first: the list is read to decide what to delete, and a 200-line
  // unreachable class is a different finding from a three-line helper. File and
  // line break the tie so the order is stable across runs.
  const ranked = [...entries.values()].sort(
    (a, b) =>
      b.lines - a.lines ||
      a.node.filePath.localeCompare(b.node.filePath) ||
      a.node.startLine - b.node.startLine
  );

  return {
    entries: ranked.slice(0, limit),
    total: ranked.length,
    candidates: candidates.length,
    excluded,
    kinds,
    includeExported,
    bounded,
    corroborated: readSource !== null,
  };
}

/**
 * Reads a project-relative file off disk, for callers with no chokepoint of
 * their own (the CLI, a library user). Refuses anything that escapes the
 * project root — a `filePath` comes out of the index, but the index is a file
 * on disk and this module should not be the thing that trusts it.
 */
function defaultSourceReader(cg: CodeGraph): (filePath: string) => string | null {
  const root = path.resolve(cg.getProjectRoot());
  return (filePath: string): string | null => {
    try {
      const absolute = path.resolve(root, filePath);
      if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_CORROBORATION_BYTES) return null;
      return fs.readFileSync(absolute, 'utf8');
    } catch {
      return null;
    }
  };
}

/**
 * How many times `name` is written in `source` as a whole identifier, counting
 * no further than `stopAt`.
 *
 * Deliberately dumb: no parsing, no comment or string stripping. A mention in a
 * comment or in a string is exactly the kind of thing that turns out to be a
 * reflective call or a registration key, and the rule this serves only ever
 * uses the count to say LESS. `\b` is not used because it is ASCII-only in
 * JavaScript and an identifier may not be.
 */
export function mentionCount(source: string, name: string, stopAt = Number.MAX_SAFE_INTEGER): number {
  if (name.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(name, from);
    if (at < 0) return count;
    from = at + name.length;
    if (!isIdentifierChar(source[at - 1]) && !isIdentifierChar(source[from])) {
      count += 1;
      if (count >= stopAt) return count;
    }
  }
}

function isIdentifierChar(char: string | undefined): boolean {
  if (char === undefined) return false;
  return char === '_' || char === '$' || /[\p{L}\p{N}]/u.test(char);
}

/**
 * Files in the candidate set that nothing else in the index reaches.
 *
 * One batched query for the whole set (`getFileDependentCounts` counts through
 * the symbols, because an `imports` edge points at the imported symbol and a
 * file node almost never receives one). Zero means nothing else in the index
 * reaches into this file at all.
 */
function filesNothingReaches(cg: CodeGraph, filePaths: readonly string[]): Set<string> {
  const unique = [...new Set(filePaths)];
  if (unique.length === 0) return new Set();
  const dependents = cg.getFileDependentCounts(unique);
  return new Set(unique.filter((path) => (dependents.get(path) ?? 0) === 0));
}

/** A file whose contents are declarations for somebody else — see {@link HEADER_EXTENSIONS}. */
export function isHeaderFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return HEADER_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A qualified name that runs through a test scope — see {@link TEST_SCOPE_SEGMENTS}. */
export function isTestScope(qualifiedName: string): boolean {
  for (const segment of qualifiedName.split(/[.:/\\#>]+/)) {
    if (TEST_SCOPE_SEGMENTS.has(segment.toLowerCase())) return true;
  }
  return false;
}

/** Code the repository carries rather than owns — see {@link VENDOR_SEGMENTS}. */
export function isVendoredPath(filePath: string): boolean {
  for (const segment of filePath.replace(/\\/g, '/').split('/')) {
    if (VENDOR_SEGMENTS.has(segment.toLowerCase())) return true;
  }
  return false;
}

/** A name the language calls by itself, so no source file could name it. */
export function isImplicitEntryName(name: string): boolean {
  return DUNDER.test(name) || IMPLICIT_ENTRY_NAMES.has(name.toLowerCase());
}

function normalizeKinds(requested: readonly NodeKind[] | undefined): NodeKind[] {
  if (!requested || requested.length === 0) return [...DEAD_CODE_KINDS];
  const kinds = requested.filter((kind) => DEAD_CODE_ALLOWED_KINDS.has(kind));
  return kinds.length > 0 ? [...new Set(kinds)] : [...DEAD_CODE_KINDS];
}

/**
 * The type each candidate is declared in, for the candidates that are members.
 *
 * One batched query for the whole candidate set, then one for the containers
 * themselves — never a lookup per row. Only type-ish containers are returned: a
 * function's container is the file, which tells us nothing.
 */
function containersOf(cg: CodeGraph, nodes: readonly Node[]): Map<string, Node> {
  const memberIds = nodes.filter((node) => OVERRIDABLE_KINDS.has(node.kind)).map((n) => n.id);
  const out = new Map<string, Node>();
  if (memberIds.length === 0) return out;

  const edges = cg.getIncomingEdgesTo(memberIds, ['contains']);
  const byMember = new Map<string, string>();
  for (const edge of edges) if (!byMember.has(edge.target)) byMember.set(edge.target, edge.source);

  const containerNodes = cg.getNodesByIds([...new Set(byMember.values())]);
  for (const [memberId, containerId] of byMember) {
    const container = containerNodes.get(containerId);
    if (container && CONTAINER_KINDS.has(container.kind)) out.set(memberId, container);
  }
  return out;
}

/**
 * Which candidates override something — the ids to drop.
 *
 * A method that overrides `Base.run` is reached through `Base.run`; the call
 * site names the base, so the override carries no incoming edge of its own and
 * would otherwise head the list. It is matched by NAME within a chain the graph
 * already links (nothing in the engine emits an `overrides` edge), exactly as
 * the type-hierarchy block does.
 *
 * The second rule is the one that looks wrong and is not: **an ancestor with no
 * extracted members counts as a match.** A TypeScript interface of pure method
 * signatures produces no `contains` edges at all, so `class X implements Y`
 * with every member of `Y` implemented reads, structurally, as a class whose
 * members override nothing. Answering "cannot tell" with an exclusion is the
 * only choice that keeps the list's promise; the alternative puts every
 * implementation of every signature-only interface at the top of a screen that
 * says "nothing reaches this".
 */
function overrideCandidates(
  cg: CodeGraph,
  nodes: readonly Node[],
  containers: ReadonlyMap<string, Node>
): Set<string> {
  const dropped = new Set<string>();
  const containerIds = [...new Set([...containers.values()].map((node) => node.id))];
  if (containerIds.length === 0) return dropped;

  // Level-by-level upward walk over EVERY container at once: one query per
  // level rather than one per container. `reach` maps an ancestor back to the
  // containers it is an ancestor of.
  const reach = new Map<string, Set<string>>();
  const seen = new Set<string>(containerIds);
  let frontier = containerIds.map((id) => ({ id, roots: new Set<string>([id]) }));

  for (let depth = 0; depth < MAX_OVERRIDE_ANCESTOR_DEPTH && frontier.length > 0; depth++) {
    const rootsOf = new Map(frontier.map((item) => [item.id, item.roots]));
    const edges = cg.getOutgoingEdgesFrom(
      frontier.map((item) => item.id),
      ['extends', 'implements']
    );
    const next = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (edge.target === edge.source) continue;
      const roots = rootsOf.get(edge.source);
      if (!roots) continue;
      const merged = next.get(edge.target) ?? new Set<string>();
      for (const root of roots) merged.add(root);
      next.set(edge.target, merged);
      const known = reach.get(edge.target) ?? new Set<string>();
      for (const root of roots) known.add(root);
      reach.set(edge.target, known);
    }
    frontier = [];
    for (const [id, roots] of next) {
      if (seen.has(id)) continue;
      seen.add(id);
      frontier.push({ id, roots });
    }
  }

  if (reach.size === 0) return dropped;

  // What each ancestor declares, and whether it declares anything at all.
  const ancestorIds = [...reach.keys()];
  const memberEdges = cg.getOutgoingEdgesFrom(ancestorIds, ['contains']);
  const memberIdsByAncestor = new Map<string, string[]>();
  for (const edge of memberEdges) {
    const bucket = memberIdsByAncestor.get(edge.source);
    if (bucket) bucket.push(edge.target);
    else memberIdsByAncestor.set(edge.source, [edge.target]);
  }
  const memberNodes = cg.getNodesByIds(memberEdges.map((edge) => edge.target));

  /** Member names an ancestor declares, and whether it declares none we can read. */
  const namesByContainer = new Map<string, Set<string>>();
  const opaqueContainers = new Set<string>();
  for (const [ancestorId, roots] of reach) {
    const names: string[] = [];
    for (const memberId of memberIdsByAncestor.get(ancestorId) ?? []) {
      const member = memberNodes.get(memberId);
      if (member && OVERRIDABLE_KINDS.has(member.kind)) names.push(member.name);
    }
    for (const root of roots) {
      if (names.length === 0) {
        opaqueContainers.add(root);
        continue;
      }
      const bucket = namesByContainer.get(root) ?? new Set<string>();
      for (const name of names) bucket.add(name);
      namesByContainer.set(root, bucket);
    }
  }

  for (const node of nodes) {
    const container = containers.get(node.id);
    if (!container) continue;
    if (opaqueContainers.has(container.id)) {
      dropped.add(node.id);
      continue;
    }
    if (namesByContainer.get(container.id)?.has(node.name)) dropped.add(node.id);
  }
  return dropped;
}
