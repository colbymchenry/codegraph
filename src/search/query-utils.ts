/**
 * Search Query Utilities
 *
 * Shared module for search term extraction and scoring.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node } from '../types';

/** Normalize a name to a comparable token: lowercase, alphanumerics only. */
export function normalizeNameToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tokens that name the PROJECT as a whole — its `go.mod` module, `package.json`
 * name, or repo root directory — rather than any specific symbol. A user
 * naturally puts the project name in a query as context ("MyApp backend
 * routes"), but it carries no discriminative signal: when it's also a substring
 * of a symbol or path on one stack (a `MyAppFrontend/` dir, a `MyAppApp` class)
 * it lexically inflates that stack and buries the rest (#720).
 *
 * Returned normalized (lowercase, alphanumerics only) so a query word can be
 * compared by its normalized form. Only names ≥5 chars are kept — short ones
 * (`api`, `app`, `core`, `web`) collide with real query terms too often to
 * safely down-weight.
 */
export function deriveProjectNameTokens(projectRoot: string): Set<string> {
  const tokens = new Set<string>();
  const add = (raw: string | undefined | null): void => {
    if (!raw) return;
    const norm = normalizeNameToken(raw);
    if (norm.length >= 5) tokens.add(norm);
  };

  // go.mod module last segment (the most reliable signal for Go repos).
  try {
    const gomod = fs.readFileSync(path.join(projectRoot, 'go.mod'), 'utf-8');
    const m = gomod.match(/^\s*module\s+(\S+)/m);
    if (m && m[1]) add(m[1].split('/').pop());
  } catch { /* no go.mod */ }

  // package.json name (strip an `@scope/` prefix).
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    if (typeof pkg.name === 'string') add(pkg.name.replace(/^@[^/]+\//, ''));
  } catch { /* no / invalid package.json */ }

  // Repo root directory name — a fallback when neither manifest names the project.
  add(path.basename(path.resolve(projectRoot)));

  return tokens;
}

/**
 * Common stop words to filter from search queries.
 * Includes generic English + code-specific noise words.
 */
export const STOP_WORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'are', 'was',
  'be', 'has', 'had', 'have', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'not', 'no', 'all', 'each',
  'every', 'how', 'what', 'where', 'when', 'who', 'which', 'why',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  'show', 'give', 'tell',
  'been', 'done', 'made', 'used', 'using', 'work', 'works', 'found',
  'also', 'into', 'then', 'than', 'just', 'more', 'some', 'such',
  'over', 'only', 'out', 'its', 'so', 'up', 'as', 'if',
  'look', 'need', 'needs', 'want', 'happen', 'happens',
  'affect', 'affected', 'break', 'breaks', 'failing',
  'implemented', 'implement',
  // Code-specific noise (avoid filtering common symbol names like get/set/add/build/find/list)
  'code', 'file', 'files', 'function', 'method', 'class', 'type',
  'fix', 'bug', 'called',
]);

/**
 * Generate stem variants of a search term by removing common English suffixes.
 * Used for FTS query expansion so "caching" also finds "cache", "eviction" finds "evict", etc.
 * Stems are used as PREFIX matches in FTS, so they don't need to be perfect English words.
 */
export function getStemVariants(term: string): string[] {
  const variants = new Set<string>();
  const t = term.toLowerCase();

  // -ing: caching→cach/cache, handling→handl/handle, running→run
  if (t.endsWith('ing') && t.length > 5) {
    const base = t.slice(0, -3);
    variants.add(base);
    variants.add(base + 'e');
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  // -tion/-sion: eviction→evict, expression→express
  if ((t.endsWith('tion') || t.endsWith('sion')) && t.length > 5) {
    variants.add(t.slice(0, -3));
  }

  // -ment: management→manage
  if (t.endsWith('ment') && t.length > 6) {
    variants.add(t.slice(0, -4));
  }

  // -ies: entries→entry
  if (t.endsWith('ies') && t.length > 4) {
    variants.add(t.slice(0, -3) + 'y');
  }
  // -es: processes→process, classes→class
  else if (t.endsWith('es') && t.length > 4) {
    variants.add(t.slice(0, -2));
  }
  // -s: errors→error (skip -ss endings like "class")
  else if (t.endsWith('s') && !t.endsWith('ss') && t.length > 4) {
    variants.add(t.slice(0, -1));
  }

  // -ed: handled→handle, propagated→propagate, carried→carry
  if (t.endsWith('ed') && !t.endsWith('eed') && t.length > 4) {
    variants.add(t.slice(0, -1));
    variants.add(t.slice(0, -2));
    if (t.endsWith('ied') && t.length > 5) {
      variants.add(t.slice(0, -3) + 'y');
    }
  }

  // -er: builder→build/builde, handler→handl/handle, getter→get
  if (t.endsWith('er') && t.length > 4) {
    const base = t.slice(0, -2);
    variants.add(base);
    variants.add(base + 'e');
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      variants.add(base.slice(0, -1));
    }
  }

  return [...variants].filter(v => v.length >= 3 && v !== t);
}

/**
 * Extract meaningful search terms from a natural language query.
 * Splits camelCase, PascalCase, snake_case, SCREAMING_SNAKE, and dot.notation
 * into individual tokens before filtering.
 *
 * Preserves original compound identifiers (e.g., "scrapeLoop") alongside
 * their split parts so that FTS can match both the full symbol name and
 * individual words within it.
 *
 * Also generates stem variants (e.g., "caching"→"cache", "eviction"→"evict")
 * so FTS prefix matching can find related code symbols.
 */
export function extractSearchTerms(query: string, options?: { stems?: boolean }): string[] {
  const includeStems = options?.stems !== false;
  const tokens = new Set<string>();

  // First, extract and preserve compound identifiers before splitting
  // CamelCase: scrapeLoop, UserService, getCallGraph
  const compoundPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = compoundPattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      tokens.add(match[1].toLowerCase()); // preserve full compound: "scrapeloop"
    }
  }

  // snake_case: scrape_loop, user_service
  const snakePattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b/g;
  while ((match = snakePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      tokens.add(match[1].toLowerCase());
    }
  }

  // Split camelCase / PascalCase: "getUserName" → "get User Name"
  const camelSplit = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Replace underscores and dots with spaces (snake_case, dot.notation)
  const normalised = camelSplit.replace(/[_.]+/g, ' ');

  // Split on any non-alphanumeric character
  const words = normalised.split(/[^a-zA-Z0-9]+/).filter(Boolean);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length < 3) continue;
    if (STOP_WORDS.has(lower)) continue;
    tokens.add(lower);
  }

  // Generate stem variants for broader FTS matching.
  // "caching" → "cache" finds CacheBuilder; "eviction" → "evict" finds evictEntries.
  // Also enables co-occurrence dampening by increasing term count above 1.
  // Stems are skipped when scoring path relevance (stems inflate path scores).
  if (includeStems) {
    const stems = new Set<string>();
    for (const token of tokens) {
      for (const variant of getStemVariants(token)) {
        if (!tokens.has(variant) && !STOP_WORDS.has(variant)) {
          stems.add(variant);
        }
      }
    }
    for (const stem of stems) {
      tokens.add(stem);
    }
  }

  return [...tokens];
}

/**
 * Score path relevance to a query
 * Higher score = more relevant path
 */
export function scorePathRelevance(
  filePath: string,
  query: string,
  projectNameTokens?: Set<string>,
  isDeprioritized?: boolean,
): number {
  const pathLower = filePath.toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  const dirName = path.dirname(filePath).toLowerCase();
  let score = 0;

  // Score per original query WORD, not per sub-token. A single PascalCase word
  // splits into many sub-tokens (a project name "SuperBizAgent" →
  // superbizagent / super / biz / agent) that all match the SAME path segment,
  // so summing per sub-token boosted that path 4× for one concept — enough to
  // bury the rest of the query's stack (#720). A word matches a path level if
  // ANY of its sub-tokens do, and counts ONCE; distinct words still each add.
  // Split the ORIGINAL-case query into words; extractSearchTerms does the
  // camelCase/snake split per word (so `getUserName` still matches a
  // `get_user_name` path) — we just attribute each word's matches once.
  const allWords = query.split(/\s+/).filter((w) => w.length > 0);
  if (allWords.length === 0) return 0;

  // A query word that just names the PROJECT (its go.mod / package.json / repo
  // name) carries no discriminative path signal — drop it so the rest of the
  // query decides the ranking, instead of every file under a `<ProjectName>…/`
  // tree winning on the project name alone (#720). Only when OTHER words remain,
  // so a bare project-name query still scores on its path.
  const words =
    projectNameTokens && projectNameTokens.size > 0
      ? allWords.filter((w) => !projectNameTokens.has(normalizeNameToken(w)))
      : allWords;
  const scored = words.length > 0 ? words : allWords;

  for (const word of scored) {
    // Use base terms only — stem variants inflate path scores by generating
    // many near-duplicate terms that all match the same path segments.
    const subtokens = extractSearchTerms(word, { stems: false });
    if (subtokens.length === 0) continue;
    // Exact filename match (strongest)
    if (subtokens.some((t) => fileName.includes(t))) score += 10;
    // Directory match
    if (subtokens.some((t) => dirName.includes(t))) score += 5;
    // General path match
    else if (subtokens.some((t) => pathLower.includes(t))) score += 3;
  }

  // Deprioritize test files unless the query is explicitly about tests, and
  // apply the same -15 to a path the project declared peripheral (#982).
  //
  // Two deliberate asymmetries, both pinned by tests:
  //  - the built-in test/fixture penalty is waived for a test-y query, because
  //    the tool inferred that classification; a `deprioritize` pattern is a
  //    standing statement by the project, so it is NOT waived. The name-bonus
  //    damping at the call site is what keeps such a tree findable.
  //  - a path that is both is docked ONCE, not twice.
  const queryLower = query.toLowerCase();
  const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');
  const offTarget = (!isTestQuery && isTestFile(filePath)) || isDeprioritized === true;
  if (offTarget) {
    score -= 15;
  }

  return score;
}

/**
 * Check if a file path looks like a test file
 *
 * "Test" here is the wide reading: anything that is not production code,
 * including examples, samples, benchmarks and fixtures. That is the right
 * default for ranking — none of them are what a search is looking for — but it
 * is the wrong set to put under a heading that says "Tests". A caller that
 * means literally a test suite wants {@link isTestPath}.
 */
export function isTestFile(filePath: string): boolean {
  // Non-production directories: examples, samples, benchmarks, fixtures, demos.
  // Check both mid-path (/integration/) and start-of-path (integration/) since
  // file paths may be stored as relative paths without a leading slash.
  return isTestPath(filePath) || matchesNonProductionDir(filePath.toLowerCase());
}

/**
 * Check if a file path names a TEST — a suite that exercises other code.
 *
 * The narrow half of {@link isTestFile}: the filename and directory
 * conventions every ecosystem uses for its test suites, and nothing else. An
 * example, a benchmark or a fixture is not a test, and a list headed "Tests"
 * that contains them is telling the reader something untrue.
 */
export function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const fileName = path.basename(filePath);   // original case — needed for camelCase boundaries
  const lowerName = fileName.toLowerCase();

  // --- Filename patterns ---
  if (
    lowerName.startsWith('test_') ||                              // python: test_foo.py
    lowerName.startsWith('test.') ||
    // separator-delimited: foo_test.go, foo.test.ts, foo-spec.rb, bar_spec.py
    /[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lowerName) ||
    // CamelCase suffix (Java/Kotlin/Swift/C#/Scala): FooTest.kt, BarTests.swift,
    // BazSpec.scala, QuxTestCase.java. Capital-led so "latest.kt"/"manifest.kt"
    // (lowercase "test") are NOT matched.
    /(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$/.test(fileName)
  ) {
    return true;
  }

  // --- Directory patterns ---
  if (
    lower.includes('/tests/') || lower.includes('/test/') ||
    lower.includes('/__tests__/') || lower.includes('/spec/') ||
    lower.includes('/specs/') || lower.includes('/testlib/') ||
    lower.includes('/testing/') || lower.includes('/e2e/') ||
    lower.startsWith('test/') || lower.startsWith('tests/') ||
    lower.startsWith('spec/') || lower.startsWith('specs/') ||
    lower.startsWith('e2e/') ||
    // CamelCase test source-set dirs (Kotlin Multiplatform / Gradle / Xcode):
    // jvmTest/, commonTest/, androidTest/, iosTest/, integrationTest/. Capital-led
    // so "latest/" / "manifest/" are not matched.
    /(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath) ||
    // Test-support modules and doubles by directory name: Gradle's
    // `core/data-test/`, `core/datastore-test/`, `:testing`; Go's `testdata/`;
    // `testutil(s)/`, `test-utils/`, `fakes/`, `mocks/`, `__mocks__/`.
    /(?:^|\/)(?:[\w.]+[-_]test(?:s|ing)?|testdata|testutils?|test[-_]utils?|fakes?|mocks?|__mocks__|stubs)\//.test(lower)
  ) {
    return true;
  }

  return false;
}

/**
 * Check if a path is in a non-production directory (integration, sample, example, etc.)
 * Handles both absolute paths (/foo/integration/bar) and relative paths (integration/bar).
 */
function matchesNonProductionDir(lowerPath: string): boolean {
  const dirs = [
    'integration', 'sample', 'samples', 'example', 'examples',
    'fixture', 'fixtures', 'benchmark', 'benchmarks', 'demo', 'demos',
  ];
  // Only the project layout above a `src/` counts, never the package path
  // below it: `core/data/src/main/kotlin/com/google/samples/apps/…` is a
  // Google sample by name and production code by layout.
  const src = lowerPath.indexOf('/src/');
  const scope = src >= 0 ? lowerPath.slice(0, src + 1) : lowerPath.startsWith('src/') ? '' : lowerPath;
  for (const dir of dirs) {
    if (scope.includes('/' + dir + '/') || scope.startsWith(dir + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Corpus statistics used to discount an exact name match by how common the
 * name is. Supplied by the caller because only the DB layer can count names.
 */
export interface NameCorpusStats {
  /** Total indexed nodes. */
  total: number;
  /** How many indexed nodes carry this exact name (case-insensitive). */
  countForName(name: string): number;
}

/**
 * Floor for {@link nameMatchIdfScale}: a common name is discounted, never erased.
 *
 * Measured, not chosen. Swept 0→1 over the top-25 corpus-common names of five
 * indexed repos (gin 2.5k nodes, Alamofire 4.5k, codegraph 9.2k, excalidraw
 * 11k, django 62k), scoring two things: whether a query that IS a common name
 * still returns that name first, and how much of a mixed query's top-10 the
 * common name crowds out.
 *
 * Real corpora never drive the raw scale below ~0.36 (django's commonest name
 * spans 1097 of 62080 nodes → 0.367), so any floor at or under 0.35 is inert —
 * an earlier 0.25 was dead code. The binding cases are milder and real:
 * searching Alamofire for `alamofire` (scale 0.551) or `request` (0.392)
 * demoted the symbol with that exact name below a mere *prefix* match
 * (`AlamofireExtended`, `requests`), which is never right — the user typed the
 * name. 0.60 is the lowest value clearing the worst such case (0.551) with
 * margin; it restores exact-name recall@1 to the undiscounted baseline on all
 * five repos while keeping ~95% of the crowd-out relief.
 */
export const NAME_MATCH_IDF_FLOOR = 0.6;

/**
 * Damping applied to the exact-name bonus of a node the project de-prioritized
 * (#1463). Lives here, next to the other exact-name lever, because the two
 * compose and only {@link combinedExactNameScale} can hold the bound they
 * share. Re-exported from the DB layer for the callers that had it there.
 */
export const DEPRIORITIZED_NAME_BONUS_SCALE = 0.75;

/**
 * Floor for the *combined* exact-name multiplier (#1462 + #1463).
 *
 * Both levers discount the same bonus, and each was derived against the same
 * invariant with the other lever off: an exact name the user typed never loses
 * to a mere prefix match. Multiplied they break it — a corpus-common name in a
 * de-prioritized tree lands at `80 * 0.6 * 0.75 - 15 = 21`, under the prefix
 * arm's supremum of 40.
 *
 * A de-prioritized node also carries the flat -15 path penalty, so the bound is
 * `round(80 * s) - 15 > 40`, i.e. `s >= 0.69375`. 0.70 is the next clean value
 * above it and leaves `round(80 * 0.70) - 15 = 41`.
 *
 * Note this is a floor on the product, not `min` of the two: `min(0.6, 0.75)`
 * is 0.6, which is itself under the bound — taking the stronger discount alone
 * does not clear it.
 */
export const COMBINED_EXACT_NAME_FLOOR = 0.7;

/**
 * The exact-name multiplier once both discounts are taken into account.
 *
 * @param idfScale - Corpus-frequency scale from {@link nameMatchIdfScale}.
 * @param deprioritized - Whether the node sits in a de-prioritized path.
 * @returns Multiplier for the exact-name bonus, never below the shared bound
 *   when de-prioritized (where the -15 path penalty also applies).
 */
export function combinedExactNameScale(idfScale: number, deprioritized: boolean): number {
  if (!deprioritized) return idfScale;
  return Math.max(COMBINED_EXACT_NAME_FLOOR, idfScale * DEPRIORITIZED_NAME_BONUS_SCALE);
}

/**
 * IDF-style scale for an exact-name bonus, in [NAME_MATCH_IDF_FLOOR, 1].
 *
 * An exact name match is strong evidence only when the name is rare. A bare
 * `usage` that names hundreds of symbols carries almost no signal, yet used to
 * collect the same flat bonus as a name that occurs once — enough to outrank
 * product code that does not literally contain the token (#982, the
 * corpus-frequency discount #746 left unimplemented).
 *
 * `log(1 + total/df) / log(1 + total)` gives exactly 1 for a unique name, so
 * the common case is unchanged, and decays as the name spreads. The floor keeps
 * a genuinely-intended query for a common name (an actual `usage()` reporter)
 * ranking above non-matches: the aim is to discount the signal, not erase it.
 *
 * @param df - Number of indexed nodes sharing the name.
 * @param total - Total indexed nodes.
 * @returns Multiplier for the exact-name bonus.
 */
export function nameMatchIdfScale(df: number, total: number): number {
  if (!Number.isFinite(df) || !Number.isFinite(total)) return 1;
  if (df <= 1 || total <= 1) return 1;
  const capped = Math.min(df, total);
  const scale = Math.log(1 + total / capped) / Math.log(1 + total);
  return Math.max(NAME_MATCH_IDF_FLOOR, Math.min(1, scale));
}

/**
 * Bonus when a node's name matches the search query.
 * Exact matches get the largest boost; prefix matches get smaller boosts.
 * Multi-word queries also check individual term matches against the name.
 *
 * @param corpus - Optional corpus stats. When given, the two exact-name bonuses
 *   are scaled by {@link nameMatchIdfScale} so a name shared by many symbols
 *   stops dominating. Omitted (or unavailable) leaves scoring as before.
 */
export function nameMatchBonus(
  nodeName: string,
  query: string,
  corpus?: NameCorpusStats,
  deprioritized = false,
): number {
  const nameLower = nodeName.toLowerCase();

  // Only the exact-name arms below take the corpus discount. Prefix/substring
  // bonuses are already small and length-scaled, so they never produced the
  // #982 crowd-out. The de-prioritized damping applies to every arm (#1463) —
  // it is the whole name signal that the project called peripheral — but only
  // the exact arms compose two discounts, so only they need the shared floor.
  const idf = corpus ? nameMatchIdfScale(corpus.countForName(nameLower), corpus.total) : 1;
  const exact = (bonus: number): number =>
    Math.round(bonus * combinedExactNameScale(idf, deprioritized));
  const other = (bonus: number): number =>
    deprioritized ? Math.round(bonus * DEPRIORITIZED_NAME_BONUS_SCALE) : bonus;

  // Split query into word-level terms (handles "CacheBuilder build" → ["cache","builder","build"])
  const rawTerms = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_.\-]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2);

  // Also keep original space-separated tokens for exact-term matching
  const queryTokens = query.split(/\s+/).map(t => t.toLowerCase()).filter(t => t.length >= 2);

  // Full query as a single token (for compound identifiers like "CacheBuilder")
  const queryLower = query.replace(/[\s]+/g, '').toLowerCase();

  // Exact match: query exactly equals the node name
  if (nameLower === queryLower) return exact(80);

  // Exact match on a query token: "CacheBuilder build" and node name is "build"
  if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return exact(60);

  // Name starts with query — scale by length ratio so "Pod"→"Pod" (exact, handled above)
  // scores much higher than "Pod"→"PodGCControllerOptions" (ratio 0.125).
  if (nameLower.startsWith(queryLower)) {
    const ratio = queryLower.length / nameLower.length;
    return other(Math.round(10 + 30 * ratio));
  }

  // All camelCase-split terms appear in the name
  if (rawTerms.length > 1) {
    const allMatch = rawTerms.every(t => nameLower.includes(t));
    if (allMatch) return other(15);
  }

  // Name contains the full query as substring
  if (nameLower.includes(queryLower)) return other(10);

  return 0;
}

/**
 * Kind-based bonus for search ranking
 * Functions and classes are typically more relevant than variables/imports
 */
export function kindBonus(kind: Node['kind']): number {
  const bonuses: Record<string, number> = {
    function: 10,
    method: 10,
    class: 8,
    interface: 9,
    type_alias: 6,
    struct: 6,
    union: 6,
    trait: 9,
    enum: 5,
    component: 8,
    route: 9,
    module: 4,
    property: 3,
    field: 3,
    variable: 2,
    constant: 3,
    import: 1,
    export: 1,
    parameter: 0,
    namespace: 4,
    file: 0,
    protocol: 9,
    enum_member: 3,
  };
  return bonuses[kind] ?? 0;
}

/**
 * Whether a query token looks like a code identifier the user deliberately typed
 * (camelCase / PascalCase-with-internal-caps / snake_case / has a digit) rather
 * than a plain dictionary word ("flat", "object", "screen").
 *
 * Used to decide whether an EXACT name match earns the "the user named this
 * symbol" exemption from single-term dampening. A common English word that
 * happens to exact-match an unrelated symbol — the query "flat object" matching
 * a constant named `FLAT` — must NOT get that exemption, or the +exact-name
 * bonus floats it to the top of a prose query on its own.
 *
 * Classifies the token AS THE USER TYPED IT, not the matched symbol's name:
 * "flat" (lowercase, descriptive) is non-distinctive even though it matches
 * `FLAT`. A leading-capital-only word ("Screen", "Zustand") is also treated as
 * a plain word — sentence-start capitalization and proper nouns aren't reliable
 * identifier signals.
 */
export function isDistinctiveIdentifier(token: string): boolean {
  if (!token) return false;
  // snake_case / SCREAMING_SNAKE, or an embedded digit → a deliberate identifier.
  if (/[_0-9]/.test(token)) return true;
  // An uppercase letter anywhere AFTER the first char → a camelCase/PascalCase
  // boundary (setLastEmail, OrgUserStore) or an acronym (REST, HTTP).
  if (/[A-Z]/.test(token.slice(1))) return true;
  return false;
}
