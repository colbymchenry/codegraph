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
    expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [] });
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
    expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [] });
  });

  it('leaves a stem shared by too many files alone — one hot name must not pin half the repo', () => {
    const q = 'refactor the user-profile rendering';
    const out = extractQueryPaths(q, INDEX);
    expect(out).toEqual({ strippedQuery: q, pinnedFiles: [], unresolvedPathSpans: [] });
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
