/**
 * Identifier-segment utilities for the prompt hook's graph-derived gate
 * (name_segment_vocab): symbol names split into the words a human would use
 * for them in prose, and prompt prose normalized into candidate words to look
 * those segments up with.
 *
 * "OrderStateMachine" → order / state / machine — so the French prompt
 * "comment marche la state machine des commandes ?" (or any language's prose
 * naming the concept in Latin script) can be verified against the graph
 * without a keyword list ever knowing the words. The FTS index can't serve
 * this — its tokenizer keeps camelCase names as single tokens — which is why
 * segments are materialized at index time instead (see schema.sql,
 * name_segment_vocab).
 */

/** Bounds keep degenerate identifiers (minified names, hashes) from bloating
 *  the vocab: segments outside them carry no prose signal anyway. */
const MIN_SEGMENT_CHARS = 2;
const MAX_SEGMENT_CHARS = 32;
const MAX_SEGMENTS_PER_NAME = 12;

/**
 * Split a symbol or file name into lowercase word segments.
 *
 * Handles camelCase / PascalCase (inner lower→Upper), acronym runs
 * ("HTMLParser" → html/parser), snake_case / kebab-case / dotted file names
 * (non-alphanumerics separate), and keeps digits glued to their word
 * ("base64Encode" → base64/encode). Digit-only fragments are dropped.
 */
export function splitIdentifierSegments(name: string): string[] {
  if (!name) return [];
  const out = new Set<string>();
  for (const run of name.match(/[\p{L}\p{N}]+/gu) ?? []) {
    // Split before an Upper that follows lower/digit (camelCase hump), and
    // before the last Upper of an acronym run when a lowercase follows
    // ("HTMLParser" → HTML | Parser).
    const parts = run.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u);
    for (const part of parts) {
      if (out.size >= MAX_SEGMENTS_PER_NAME) return [...out];
      const seg = part.toLowerCase();
      if (seg.length < MIN_SEGMENT_CHARS || seg.length > MAX_SEGMENT_CHARS) continue;
      if (/^\p{N}+$/u.test(seg)) continue;
      out.add(seg);
    }
  }
  return [...out];
}

/**
 * Normalize a prose word for segment lookup: lowercase + strip diacritics
 * (NFD, drop combining marks), so "références" matches the segment
 * "references" and "résolution" matches "resolution". Identifier segments are
 * overwhelmingly ASCII, so this is what buys Latin-script languages their
 * cross-lingual reach on loanwords.
 */
export function normalizeProseWord(word: string): string {
  return word.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Candidate cap: a prompt's first words carry its subject; scanning an essay
 *  buys nothing and the vocab lookup cost scales with this. */
const MAX_PROSE_CANDIDATES = 16;
const MIN_PROSE_CHARS = 4; // "the"/"des"/"une"/"fix" out; "auth"/"flow"/"path" in
const MAX_PROSE_CHARS = 24; // an unsegmented-script sentence is one giant run — skip it

/**
 * English prompt words that are never evidence a symbol was NAMED, however
 * rare their segment happens to be in a given repo: function words, filler,
 * hyper-common dev verbs, and words ABOUT code rather than OF it ("rename
 * this file", "there's an issue"). Measured FPs that motivated this: "fix
 * THIS typo" matched `resolveDeferredThisMemberRefs` (repo-rare segment!),
 * "WRITE a haiku" matched `writeConfig`.
 *
 * English-only ON PURPOSE — this is not the #1126 keyword treadmill:
 * identifiers are written in English, so only English prose words can
 * accidentally collide with segments. Other languages' function words
 * ("avec", "pendant", "dieser") don't match anything and need no list.
 * Domain nouns ("state", "checkout", "order") stay OUT — they are exactly
 * the signal; the rarity/co-occurrence rules judge them per-repo.
 */
const ENGLISH_PROSE_STOPWORDS = new Set([
  'about', 'above', 'actually', 'after', 'again', 'against', 'almost', 'along', 'also', 'always',
  'another', 'anything', 'around', 'away', 'back', 'because', 'been', 'before', 'behind', 'being',
  'below', 'best', 'better', 'between', 'both', 'cannot', 'come', 'could', 'does', 'doing', 'done',
  'down', 'each', 'either', 'else', 'even', 'ever', 'every', 'everything', 'fine', 'first', 'from',
  'getting', 'give', 'goes', 'going', 'gone', 'good', 'great', 'have', 'having', 'help', 'here',
  'inside', 'instead', 'into', 'just', 'keep', 'know', 'last', 'least', 'less', 'like', 'likely',
  'little', 'look', 'looking', 'made', 'make', 'making', 'many', 'maybe', 'mind', 'more', 'most',
  'much', 'must', 'need', 'needs', 'never', 'next', 'nice', 'none', 'nothing', 'okay', 'only',
  'onto', 'other', 'otherwise', 'over', 'please', 'pretty', 'probably', 'quite', 'rather', 'really',
  'right', 'same', 'seem', 'seems', 'should', 'show', 'since', 'some', 'someone', 'something',
  'somewhere', 'soon', 'still', 'such', 'sure', 'take', 'than', 'thank', 'thanks', 'that', 'their',
  'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'think', 'this', 'those', 'though',
  'tried', 'tries', 'trying', 'under', 'until', 'upon', 'very', 'want', 'wants', 'well', 'went',
  'were', 'what', 'when', 'which', 'while', 'will', 'wish', 'with', 'within', 'without', 'would',
  'wrong', 'your', 'yours',
  // words ABOUT code, not OF it — present in a huge share of prompts while
  // almost never naming the symbol the user means
  'again', 'change', 'changes', 'check', 'class', 'classes', 'code', 'detail', 'details',
  'directory', 'error', 'errors', 'example', 'examples', 'file', 'files', 'folder', 'function',
  'functions', 'issue', 'issues', 'line', 'lines', 'method', 'methods', 'name', 'names', 'problem',
  'problems', 'project', 'question', 'questions', 'rename', 'test', 'tests', 'type', 'types',
  'update', 'value', 'values', 'warning', 'warnings', 'work', 'working', 'write', 'writing',
]);

/**
 * Candidate words from a prompt for segment-vocabulary lookup, in order of
 * appearance: Unicode letter/digit runs, normalized via
 * {@link normalizeProseWord}, length-bounded, digit-only dropped,
 * {@link ENGLISH_PROSE_STOPWORDS} dropped, deduped, capped. Everything that
 * survives is judged per-repo by the rarity and co-occurrence rules in
 * CodeGraph.getSegmentMatches — there is no domain-word list.
 */
export function extractProseCandidates(prompt: string): string[] {
  if (!prompt) return [];
  const seen = new Set<string>();
  for (const run of prompt.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (seen.size >= MAX_PROSE_CANDIDATES) break;
    if (run.length > MAX_PROSE_CHARS) continue;
    const w = normalizeProseWord(run);
    if (w.length < MIN_PROSE_CHARS || w.length > MAX_PROSE_CHARS) continue;
    if (/^\p{N}+$/u.test(w)) continue;
    if (ENGLISH_PROSE_STOPWORDS.has(w)) continue;
    seen.add(w);
  }
  return [...seen];
}

/**
 * Lookup variants for a prose word: the word itself plus light plural folding
 * ("services" → service, "dependencies" → dependencie/dependency is NOT
 * attempted — only a trailing s/es strip), so common plurals still hit their
 * singular segment. Returned variants map back to the same original word.
 *
 * The strips are keyed on English plural spelling (#1145), in three classes:
 * - UNAMBIGUOUS `-es` (after x/sh/ss/zz: boxes, hashes, classes, quizzes) —
 *   strip 2 only. Stripping 1 minted a bogus sibling ("classes" → classe).
 * - AMBIGUOUS endings (`-ches`/`-ses`/`-zes`/`-oes`): spelling alone can't
 *   split patches(+es) from caches(+s), lenses from databases, heroes from
 *   shoes — emit BOTH candidate keys and let the vocab lookup decide; a miss
 *   is an ignored key, a wrong exclusive guess would LOSE the real match.
 * - Everything else ending in `-s` — a bare `-s` plural (services, machines,
 *   cookies): strip 1 only. Stripping 2 minted "services" → servic.
 * A trailing `-ss` is a singular (class, process), not a plural: no strip —
 * that used to mint "class" → clas.
 */
export function segmentLookupVariants(word: string): string[] {
  const variants = [word];
  const canStrip2 = word.length >= MIN_PROSE_CHARS + 2;
  const canStrip1 = word.length >= MIN_PROSE_CHARS + 1;
  if (/(?:x|sh|ss|zz)es$/.test(word)) {
    if (canStrip2) variants.push(word.slice(0, -2));
  } else if (/(?:ch|s|z|o)es$/.test(word)) {
    if (canStrip2) variants.push(word.slice(0, -2));
    if (canStrip1) variants.push(word.slice(0, -1));
  } else if (word.endsWith('s') && !word.endsWith('ss')) {
    if (canStrip1) variants.push(word.slice(0, -1));
  }
  return variants;
}
