/**
 * File-path recognition in explore queries (src/search/query-paths.ts).
 *
 * The originating bug: an agent named two SvelteKit route files by exact path
 * (`src/routes/m/projects/[id]/runs/[runId]/+page.svelte`) and the explore
 * pipeline shredded them — the seeding tokenizer splits on brackets, so the
 * fragments `runId`/`scope` seeded as "named symbols" and headlined the blast
 * radius, while FTS admitted every sibling `+page.svelte` off the `page`/`runs`
 * fragments. These tests pin the module that stops that: path spans resolve
 * against the indexed file list, matching files pin, and the spans leave the
 * query. Resolution IS the detector — slash-bearing non-paths stay untouched.
 */
import { describe, it, expect } from 'vitest';
import { extractQueryPaths, queryMightContainPaths } from '../src/search/query-paths';

const INDEX = [
  'src/routes/m/projects/[id]/runs/[runId]/+page.svelte',
  'src/routes/m/projects/[id]/chat/[scope]/+page.svelte',
  'src/routes/m/projects/[id]/+page.svelte',
  'src/routes/(protected)/chat-window/+page.svelte',
  'src/lib/chat-manager.ts',
  'src/lib/task-runner-manager.ts',
  'src/lib/stores/sqlite-store.ts',
  'src/lib/stores/postgresql-store.ts',
  // Kebab-case frontend shapes (the amnisphere extension-less-basename bug):
  'src/components/training-set-page/training-set-page.tsx',
  'src/components/training-set-page/training-set-page-background-images.tsx',
  'src/components/training-set-page/training-set-page.module.scss',
  'src/components/training-set-page/background-image-table.tsx',
  'src/components/modal/add-to-training-set/add-to-training-set.tsx',
  'src/pages/library-page-layout.tsx',
  'src/api/job-manager/backgrounds.ts',
  'src/x/generic-modal.tsx',
  'src/y/generic-modal.tsx',
  'scripts/pre-commit',
  'src/a/user-profile.tsx',
  'src/b/user-profile.tsx',
  'src/c/user-profile.tsx',
  'src/d/user-profile.tsx',
];

describe('queryMightContainPaths — the cheap pre-gate', () => {
  it('fires on slashes and dotted basenames', () => {
    expect(queryMightContainPaths('look at src/lib/chat-manager.ts')).toBe(true);
    expect(queryMightContainPaths('look at chat-manager.ts please')).toBe(true);
  });

  it('stays quiet on plain prose and Class.method spans', () => {
    expect(queryMightContainPaths('how does the scroll pinning work')).toBe(false);
    // `.isPackaged` is 10 chars — past the 8-char extension cap.
    expect(queryMightContainPaths('what reads app.isPackaged here')).toBe(false);
  });

  it('fires on extension-less kebab basenames — with or without wrapping', () => {
    expect(queryMightContainPaths('background-image-table Source column')).toBe(true);
    expect(queryMightContainPaths('the `library-page-layout` wrapper')).toBe(true);
    expect(queryMightContainPaths('usage, add-to-training-set.')).toBe(true);
  });

  it('stays quiet on flags, snake_case, and snake-with-a-dash hybrids', () => {
    expect(queryMightContainPaths('run it with --no-cache maybe')).toBe(false);
    expect(queryMightContainPaths('where is background_image_table used')).toBe(false);
    expect(queryMightContainPaths('the foo_bar-baz helper')).toBe(false);
  });
});

describe('extractQueryPaths — resolution and stripping', () => {
  it.runIf(process.platform === 'win32')('recognizes native Windows separators', () => {
    expect(extractQueryPaths('src\\lib\\chat-manager.ts', INDEX).pinnedFiles)
      .toEqual(['src/lib/chat-manager.ts']);
  });

  it.runIf(process.platform !== 'win32')('does not split a backslash-bearing basename into a suffix', () => {
    const files = ['src/foo\\chat-manager.ts', 'src/foo/chat-manager.ts'];
    expect(extractQueryPaths(files[0]!, files).pinnedFiles).toEqual([files[0]]);
    expect(extractQueryPaths('chat-manager', files).pinnedFiles).toEqual([files[1]]);
  });

  it('resolves a bracketed SvelteKit path and strips it from the query', () => {
    const q = 'auto-scroll logic in src/routes/m/projects/[id]/runs/[runId]/+page.svelte — atBottom tracking';
    const out = extractQueryPaths(q, INDEX);
    expect(out.pinnedFiles).toEqual(['src/routes/m/projects/[id]/runs/[runId]/+page.svelte']);
    expect(out.strippedQuery).not.toContain('+page.svelte');
    expect(out.strippedQuery).not.toContain('runId');
    expect(out.strippedQuery).toContain('atBottom tracking');
    expect(out.unresolvedPathSpans).toEqual([]);
  });

  it('pins multiple named files in appearance order', () => {
    const q = 'compare src/routes/m/projects/[id]/chat/[scope]/+page.svelte and src/routes/m/projects/[id]/runs/[runId]/+page.svelte';
    const out = extractQueryPaths(q, INDEX);
    expect(out.pinnedFiles).toEqual([
      'src/routes/m/projects/[id]/chat/[scope]/+page.svelte',
      'src/routes/m/projects/[id]/runs/[runId]/+page.svelte',
    ]);
  });

  it('resolves a (protected) route-group path — parens are path characters', () => {
    const out = extractQueryPaths('read src/routes/(protected)/chat-window/+page.svelte', INDEX);
    expect(out.pinnedFiles).toEqual(['src/routes/(protected)/chat-window/+page.svelte']);
  });

  it('resolves an absolute path by walking suffixes to the indexed relative path', () => {
    const q = 'fix /Users/colby/dev/beads-live-dashboard/src/lib/chat-manager.ts';
    const out = extractQueryPaths(q, INDEX);
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
  });

  it('resolves a unique basename and a partial path', () => {
    expect(extractQueryPaths('see chat-manager.ts', INDEX).pinnedFiles)
      .toEqual(['src/lib/chat-manager.ts']);
    expect(extractQueryPaths('see stores/sqlite-store.ts', INDEX).pinnedFiles)
      .toEqual(['src/lib/stores/sqlite-store.ts']);
  });

  it('strips wrapping punctuation and line references', () => {
    const out = extractQueryPaths('the bug (see `src/lib/chat-manager.ts:243`).', INDEX);
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
    const hash = extractQueryPaths('regression at src/lib/task-runner-manager.ts#L88-L120', INDEX);
    expect(hash.pinnedFiles).toEqual(['src/lib/task-runner-manager.ts']);
  });

  it('treats an over-ambiguous basename as unresolved — stripped and reported', () => {
    const out = extractQueryPaths('why do all +page.svelte files flash', INDEX);
    expect(out.pinnedFiles).toEqual([]);
    expect(out.unresolvedPathSpans).toEqual(['+page.svelte']);
    expect(out.strippedQuery).toBe('why do all files flash');
  });

  it('strips and reports a clearly-path-shaped span that matches nothing', () => {
    const out = extractQueryPaths('crash in src/routes/gone/missing-page.svelte on load', INDEX);
    expect(out.pinnedFiles).toEqual([]);
    expect(out.unresolvedPathSpans).toEqual(['src/routes/gone/missing-page.svelte']);
    expect(out.strippedQuery).toBe('crash in on load');
  });

  it('leaves slash-bearing non-paths alone', () => {
    const q = 'does gen_server:call/2 block and/or timeout';
    const out = extractQueryPaths(q, INDEX);
    expect(out.pinnedFiles).toEqual([]);
    expect(out.unresolvedPathSpans).toEqual([]);
    expect(out.strippedQuery).toBe(q);
  });

  it('dedupes a path named twice and honors maxPins', () => {
    const twice = extractQueryPaths(
      'src/lib/chat-manager.ts wraps src/lib/chat-manager.ts', INDEX,
    );
    expect(twice.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);

    const capped = extractQueryPaths(
      'src/lib/chat-manager.ts src/lib/task-runner-manager.ts', INDEX, { maxPins: 1 },
    );
    expect(capped.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
  });

  it('matches case-insensitively but returns the indexed spelling', () => {
    const out = extractQueryPaths('SRC/LIB/CHAT-MANAGER.TS', INDEX);
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
  });

  it('passes through untouched when nothing resolves', () => {
    const q = 'plain prose question about scrolling';
    const out = extractQueryPaths(q, INDEX);
    expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [], lineAnchors: [], setAsideMatches: [] });
  });
});

describe('extractQueryPaths — extension-less kebab basenames', () => {
  it('pins the file a bare kebab basename names and consumes the token', () => {
    const out = extractQueryPaths('background-image-table Source column', INDEX);
    expect(out.pinnedFiles)
      .toEqual(['src/components/training-set-page/background-image-table.tsx']);
    expect(out.strippedQuery).toBe('Source column');
    expect(out.unresolvedPathSpans).toEqual([]);
  });

  it('resolves with no slash or extension anywhere in the query (session-4 shape)', () => {
    const out = extractQueryPaths(
      'TrainingSetPage train modal library-page-layout AddToTrainingSetModal usage', INDEX,
    );
    expect(out.pinnedFiles).toEqual(['src/pages/library-page-layout.tsx']);
    // Identifier-shaped tokens stay for the named-symbol seeder.
    expect(out.strippedQuery).toBe('TrainingSetPage train modal AddToTrainingSetModal usage');
  });

  it('pins every named file in a mixed dotted + kebab query (session-1 shape)', () => {
    const out = extractQueryPaths(
      'add-to-training-set training-set-page-background-images backgrounds.ts background-image-table Source column',
      INDEX,
    );
    expect(out.pinnedFiles).toEqual([
      // The dotted pass runs first, so the explicit basename pins ahead of the kebabs.
      'src/api/job-manager/backgrounds.ts',
      'src/components/modal/add-to-training-set/add-to-training-set.tsx',
      'src/components/training-set-page/training-set-page-background-images.tsx',
      'src/components/training-set-page/background-image-table.tsx',
    ]);
    expect(out.strippedQuery).toBe('Source column');
  });

  it('leaves kebab prose that names no indexed file untouched — and unreported', () => {
    const q = 'how does cross-call dedup make explore non-blocking';
    const out = extractQueryPaths(q, INDEX);
    expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [], lineAnchors: [], setAsideMatches: [] });
  });

  it('leaves a stem shared by too many files alone — one hot name must not pin half the repo', () => {
    const q = 'refactor the user-profile rendering';
    const out = extractQueryPaths(q, INDEX);
    expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [], lineAnchors: [], setAsideMatches: [] });
  });

  it('pins all files sharing a stem when within the ambiguity budget', () => {
    const out = extractQueryPaths('generic-modal close behavior', INDEX);
    expect(out.pinnedFiles).toEqual(['src/x/generic-modal.tsx', 'src/y/generic-modal.tsx']);
  });

  it('matches case-insensitively and through wrapping punctuation', () => {
    expect(extractQueryPaths('see `Background-Image-Table`.', INDEX).pinnedFiles)
      .toEqual(['src/components/training-set-page/background-image-table.tsx']);
  });

  it('stems drop only the last extension — a kebab token cannot pin a .module.scss sibling', () => {
    const out = extractQueryPaths('training-set-page props flow', INDEX);
    expect(out.pinnedFiles)
      .toEqual(['src/components/training-set-page/training-set-page.tsx']);
  });

  it('pins an extension-less indexed file by its exact name', () => {
    expect(extractQueryPaths('what does the pre-commit hook run', INDEX).pinnedFiles)
      .toEqual(['scripts/pre-commit']);
  });

  it('skips tokens the dotted pass consumed and dedupes a file named both ways', () => {
    const out = extractQueryPaths('src/lib/chat-manager.ts vs chat-manager internals', INDEX);
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
    expect(out.strippedQuery).toBe('vs internals');
  });

  it('explicit paths win the shared maxPins budget over kebab tokens', () => {
    const out = extractQueryPaths(
      'background-image-table then src/lib/chat-manager.ts', INDEX, { maxPins: 1 },
    );
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
    // The kebab token was not consumed once the budget was spent — it stays for FTS.
    expect(out.strippedQuery).toBe('background-image-table then');
  });
});

/**
 * Dotless slashed spans (#1830). `scripts/deploy` names a real file that the
 * index does not hold (no recognized extension), but the shape test demands a
 * dot-extension on the last segment — so the span was neither pinned NOR
 * reported, and its fragments (`scripts`, `deploy`) went on to feed FTS. The
 * agent got a pile of unrelated source with no hint that the file it named was
 * never consulted. Shape alone cannot decide this (`and/or` is the same shape),
 * so the caller injects an `existsOnDisk` predicate and the file's existence
 * decides. These tests also pin that the predicate is genuinely CONSULTED —
 * a predicate that is never called would make the whole arm vacuous.
 */
describe('extractQueryPaths — dotless slashed spans, decided on disk', () => {
  /** Records every span the predicate is asked about. */
  const probe = (onDisk: readonly string[]) => {
    const asked: string[] = [];
    return {
      asked,
      existsOnDisk: (rel: string) => { asked.push(rel); return onDisk.includes(rel); },
    };
  };

  it('reports a dotless path that exists on disk but is not indexed', () => {
    const p = probe(['scripts/deploy']);
    const out = extractQueryPaths(
      'why does scripts/deploy fail on release', INDEX, { existsOnDisk: p.existsOnDisk },
    );
    expect(out.pinnedFiles).toEqual([]);
    expect(out.unresolvedPathSpans).toEqual(['scripts/deploy']);
    expect(out.strippedQuery).toBe('why does fail on release');
    // Vacuity guard: the verdict came from the predicate, not from some other arm.
    expect(p.asked).toContain('scripts/deploy');
  });

  it('leaves the same span alone when no predicate is injected', () => {
    const q = 'why does scripts/deploy fail on release';
    const out = extractQueryPaths(q, INDEX);
    expect(out.unresolvedPathSpans).toEqual([]);
    expect(out.strippedQuery).toBe(q);
  });

  it('leaves `and/or` prose alone even though a predicate is injected', () => {
    const p = probe(['scripts/deploy']);
    const q = 'does gen_server:call/2 block and/or timeout';
    const out = extractQueryPaths(q, INDEX, { existsOnDisk: p.existsOnDisk });
    expect(out.pinnedFiles).toEqual([]);
    expect(out.unresolvedPathSpans).toEqual([]);
    expect(out.strippedQuery).toBe(q);
    // Consulted and refused — not skipped by shape.
    expect(p.asked).toContain('and/or');
  });

  it('leaves a slashed word pair that is not a file on disk alone', () => {
    const p = probe(['scripts/deploy']);
    const q = 'trace the input/output buffering path';
    const out = extractQueryPaths(q, INDEX, { existsOnDisk: p.existsOnDisk });
    expect(out.unresolvedPathSpans).toEqual([]);
    expect(out.strippedQuery).toBe(q);
    expect(p.asked).toContain('input/output');
  });

  it('still reports a dotted span that matches nothing and is not on disk', () => {
    const p = probe([]);
    const out = extractQueryPaths(
      'crash in src/routes/gone/missing-page.svelte on load', INDEX,
      { existsOnDisk: p.existsOnDisk },
    );
    expect(out.unresolvedPathSpans).toEqual(['src/routes/gone/missing-page.svelte']);
    expect(out.strippedQuery).toBe('crash in on load');
  });

  it('pins an indexed dotless path by resolution, never asking about it', () => {
    const p = probe(['scripts/pre-commit']);
    const out = extractQueryPaths(
      'what does scripts/pre-commit run', INDEX, { existsOnDisk: p.existsOnDisk },
    );
    expect(out.pinnedFiles).toEqual(['scripts/pre-commit']);
    expect(out.unresolvedPathSpans).toEqual([]);
    expect(p.asked).not.toContain('scripts/pre-commit');
  });
});

describe('extractQueryPaths — line anchors', () => {
  // The django follow-ups that went unanswered: an agent handed a signature for
  // a 226-line method asks for the body by line, and explore used to pin the
  // file but drop the lines — answering "the file's most relevant clusters"
  // instead of the span it named.
  const CHAT = 'src/lib/chat-manager.ts';

  it('keeps a :line / :start-end / #L suffix as an anchor on the pinned file', () => {
    expect(extractQueryPaths(`body of ${CHAT}:776`, INDEX).lineAnchors)
      .toEqual([{ file: CHAT, start: 776, end: 776 }]);
    expect(extractQueryPaths(`see ${CHAT}:12-40`, INDEX).lineAnchors)
      .toEqual([{ file: CHAT, start: 12, end: 40 }]);
    expect(extractQueryPaths('regression at src/lib/task-runner-manager.ts#L88-L120', INDEX).lineAnchors)
      .toEqual([{ file: 'src/lib/task-runner-manager.ts', start: 88, end: 120 }]);
  });

  it('binds a prose line range to the path it sits next to and removes it from the query', () => {
    const out = extractQueryPaths(`${CHAT} lines 900-1003 flushQueue tail`, INDEX);
    expect(out.lineAnchors).toEqual([{ file: CHAT, start: 900, end: 1003 }]);
    // `lines` would feed FTS a word every file holds; the numbers match nothing.
    expect(out.strippedQuery).toBe('flushQueue tail');
  });

  it('accepts the other spellings agents write', () => {
    const anchor = (q: string) => extractQueryPaths(q, INDEX).lineAnchors;
    expect(anchor(`lines 900 to 1003 of ${CHAT}`)).toEqual([{ file: CHAT, start: 900, end: 1003 }]);
    expect(anchor(`L900-L1003 in ${CHAT}`)).toEqual([{ file: CHAT, start: 900, end: 1003 }]);
    expect(anchor(`${CHAT} line 42`)).toEqual([{ file: CHAT, start: 42, end: 42 }]);
    expect(anchor(`${CHAT} 900-1003`)).toEqual([{ file: CHAT, start: 900, end: 1003 }]);
    expect(anchor(`${CHAT} (lines 1003-900)`)).toEqual([{ file: CHAT, start: 900, end: 1003 }]);
  });

  it('binds each range to its NEAREST path when the query names two files', () => {
    const out = extractQueryPaths(
      `${CHAT} lines 10-20 and src/lib/task-runner-manager.ts lines 30-40`, INDEX,
    );
    expect(out.lineAnchors).toEqual([
      { file: CHAT, start: 10, end: 20 },
      { file: 'src/lib/task-runner-manager.ts', start: 30, end: 40 },
    ]);
  });

  it('leaves line numbers alone when there is no path, or the path is ambiguous', () => {
    const noPath = extractQueryPaths('flushQueue lines 900-1003', INDEX);
    expect(noPath.lineAnchors).toEqual([]);
    // A bare number with no line context is not a line number either.
    expect(extractQueryPaths(`${CHAT} retries 3 times`, INDEX).lineAnchors).toEqual([]);
    // `generic-modal` pins two files; a line number means nothing across both.
    const twoFiles = extractQueryPaths('generic-modal.tsx:40', INDEX);
    expect(twoFiles.pinnedFiles).toHaveLength(2);
    expect(twoFiles.lineAnchors).toEqual([]);
  });
});

/**
 * A span that matches several files, narrowed by the symbols the query names.
 *
 * vscode has two `editorOptions.ts`; `editorOptions.ts clampedInt
 * cursorStyleToString` pinned both, and the pins split the reservation, so the
 * file holding the named functions got half the room it got WITHOUT the path.
 * The caller injects `symbolFiles` (the index lookup; this module stays
 * DB-free) and the matches defining a named symbol are the ones pinned.
 */
describe('extractQueryPaths — same-named files, narrowed by named symbols', () => {
  const REGISTRY = 'src/editor/config/editorOptions.ts';
  const HELPER = 'src/workbench/editor/editorOptions.ts';
  const SHARED = [...INDEX, REGISTRY, HELPER];
  /** Records every symbol the lookup is asked about. */
  const lookup = (defs: Record<string, string[]>) => {
    const asked: string[] = [];
    return {
      asked,
      symbolFiles: (symbol: string) => { asked.push(symbol); return defs[symbol] ?? []; },
    };
  };

  it('pins only the match defining a named symbol and reports the one set aside', () => {
    const l = lookup({ clampedInt: [REGISTRY], cursorStyleToString: [REGISTRY] });
    const out = extractQueryPaths(
      'editorOptions.ts clampedInt cursorStyleToString', SHARED, { symbolFiles: l.symbolFiles },
    );
    expect(out.pinnedFiles).toEqual([REGISTRY]);
    expect(out.setAsideMatches).toEqual([{ span: 'editorOptions.ts', files: [HELPER] }]);
    expect(out.strippedQuery).toBe('clampedInt cursorStyleToString');
    // The span itself is a file name, not a symbol to look up.
    expect(l.asked).toEqual(['clampedInt', 'cursorStyleToString']);
  });

  it('narrows a shared kebab stem the same way', () => {
    const l = lookup({ GenericModalFooter: ['src/y/generic-modal.tsx'] });
    const out = extractQueryPaths('generic-modal GenericModalFooter', SHARED, { symbolFiles: l.symbolFiles });
    expect(out.pinnedFiles).toEqual(['src/y/generic-modal.tsx']);
    expect(out.setAsideMatches).toEqual([{ span: 'generic-modal', files: ['src/x/generic-modal.tsx'] }]);
  });

  it('pins every match when none defines a named symbol, or every one does', () => {
    const none = lookup({ clampedInt: ['src/lib/chat-manager.ts'] });
    const noneOut = extractQueryPaths('editorOptions.ts clampedInt', SHARED, { symbolFiles: none.symbolFiles });
    expect(noneOut.pinnedFiles).toEqual([REGISTRY, HELPER]);
    expect(noneOut.setAsideMatches).toEqual([]);
    // Consulted and found nothing — not skipped.
    expect(none.asked).toEqual(['clampedInt']);

    const both = lookup({ EditorOptions: [HELPER, REGISTRY] });
    const bothOut = extractQueryPaths('editorOptions.ts EditorOptions', SHARED, { symbolFiles: both.symbolFiles });
    expect(bothOut.pinnedFiles).toEqual([REGISTRY, HELPER]);
    expect(bothOut.setAsideMatches).toEqual([]);
  });

  it('does not let a bare English word pick a file', () => {
    // `options` and `close` are words as much as names: a file defining one
    // says nothing about which same-named file the agent meant.
    const l = lookup({ options: [HELPER], close: ['src/x/generic-modal.tsx'] });
    expect(extractQueryPaths('editorOptions.ts options', SHARED, { symbolFiles: l.symbolFiles }).pinnedFiles)
      .toEqual([REGISTRY, HELPER]);
    expect(extractQueryPaths('generic-modal close behavior', SHARED, { symbolFiles: l.symbolFiles }).pinnedFiles)
      .toEqual(['src/x/generic-modal.tsx', 'src/y/generic-modal.tsx']);
    expect(l.asked).toEqual([]);
  });

  it('looks a qualified token up as written, and reads `name()` as the name', () => {
    const l = lookup({ 'EditorIntOption.clampedInt': [REGISTRY], cursorStyleFromString: [REGISTRY] });
    const out = extractQueryPaths(
      'editorOptions.ts EditorIntOption.clampedInt `cursorStyleFromString()`', SHARED,
      { symbolFiles: l.symbolFiles },
    );
    expect(out.pinnedFiles).toEqual([REGISTRY]);
    expect(l.asked).toEqual(['EditorIntOption.clampedInt', 'cursorStyleFromString']);
  });

  it('resolves a basename shared past the ambiguity budget when one match defines the named symbol', () => {
    const l = lookup({ UserProfileCard: ['src/c/user-profile.tsx'] });
    const out = extractQueryPaths('user-profile UserProfileCard', SHARED, { symbolFiles: l.symbolFiles });
    expect(out.pinnedFiles).toEqual(['src/c/user-profile.tsx']);
    expect(out.setAsideMatches).toEqual([{
      span: 'user-profile',
      files: ['src/a/user-profile.tsx', 'src/b/user-profile.tsx', 'src/d/user-profile.tsx'],
    }]);

    const dotted = extractQueryPaths('+page.svelte ChatScroller', SHARED, {
      symbolFiles: lookup({ ChatScroller: ['src/routes/(protected)/chat-window/+page.svelte'] }).symbolFiles,
    });
    expect(dotted.pinnedFiles).toEqual(['src/routes/(protected)/chat-window/+page.svelte']);
    expect(dotted.unresolvedPathSpans).toEqual([]);
  });

  it('keeps an over-budget span ambiguous when the symbols do not narrow it into budget', () => {
    const l = lookup({ PageHeader: [
      'src/routes/m/projects/[id]/runs/[runId]/+page.svelte',
      'src/routes/m/projects/[id]/chat/[scope]/+page.svelte',
      'src/routes/m/projects/[id]/+page.svelte',
      'src/routes/(protected)/chat-window/+page.svelte',
    ] });
    const out = extractQueryPaths('why do all +page.svelte PageHeader files flash', SHARED, { symbolFiles: l.symbolFiles });
    expect(out.pinnedFiles).toEqual([]);
    expect(out.unresolvedPathSpans).toEqual(['+page.svelte']);
    expect(out.setAsideMatches).toEqual([]);

    const kebab = extractQueryPaths('refactor the user-profile rendering', SHARED, { symbolFiles: l.symbolFiles });
    expect(kebab.pinnedFiles).toEqual([]);
    expect(kebab.strippedQuery).toBe('refactor the user-profile rendering');
  });

  it('binds a line anchor once the span narrows to one file', () => {
    const l = lookup({ clampedInt: [REGISTRY] });
    const out = extractQueryPaths('editorOptions.ts:1291 clampedInt', SHARED, { symbolFiles: l.symbolFiles });
    expect(out.pinnedFiles).toEqual([REGISTRY]);
    expect(out.lineAnchors).toEqual([{ file: REGISTRY, start: 1291, end: 1291 }]);
  });

  it('does not report a file the query also named by its full path', () => {
    const l = lookup({ clampedInt: [REGISTRY] });
    const out = extractQueryPaths(`editorOptions.ts clampedInt ${HELPER}`, SHARED, { symbolFiles: l.symbolFiles });
    expect(out.pinnedFiles).toEqual([REGISTRY, HELPER]);
    expect(out.setAsideMatches).toEqual([]);
  });

  it('never looks anything up for a span that matches one file', () => {
    const l = lookup({ ChatManager: ['src/lib/chat-manager.ts'] });
    const out = extractQueryPaths('chat-manager.ts ChatManager', SHARED, { symbolFiles: l.symbolFiles });
    expect(out.pinnedFiles).toEqual(['src/lib/chat-manager.ts']);
    expect(l.asked).toEqual([]);
  });
});
