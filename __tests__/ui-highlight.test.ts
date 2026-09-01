/**
 * The viewer's server-side syntax classification (CG-43, rebuilt on the
 * engine's own tree-sitter parse in CG-57).
 *
 * Two things are worth pinning here and they are not the colours. The first is
 * that a call-site link lands on the callee's own name — the accent underline
 * is the only colour in the code block, and putting it on the receiver or on a
 * word inside a comment is worse than not drawing it. The second is that
 * highlighting never becomes a way for a source request to fail: a language
 * with no grammar, an oversized slice, a minified line all have to answer with
 * the source and an honest `engine: 'plain'`.
 *
 * The end-to-end shape is deliberate: the server's tokens are fed straight
 * through the viewer's own `decodeLine` and `assignRefs`, because the seam
 * between "how a grammar chose to cut a line" and "which token the overlay
 * claims" is exactly where this breaks.
 *
 * These run against the real grammars, which live in `src/extraction/wasm/`
 * and `tree-sitter-wasms` — the same ones indexing uses — so unlike the Shiki
 * era there is nothing to build first and nothing to skip.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  clearHighlightCache,
  grammarFor,
  highlightCacheStats,
  highlightLines,
  isHighlightable,
  MAX_HIGHLIGHT_CHARS,
  SLICE_CACHE_LINES,
  TOKEN_CLASSES,
  type HighlightResult,
} from '../src/ui-server/highlight';
import { classifyTree, syntaxRegionsFor } from '../src/extraction/syntax-tokens';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { LANGUAGES } from '../src/types';
import { decodeLine, type Token } from '../ui/src/lib/highlight';
import { assignRefs, type LineRef } from '../ui/src/lib/symbol-model';

function tokensOf(result: HighlightResult, line: number): Token[] {
  return decodeLine(result.lines[line] ?? [], result.classes);
}

/** What the code block would render for one line: `class:text` per token. */
function shape(result: HighlightResult, line: number): string[] {
  return tokensOf(result, line).map((t) => `${t.cls}:${t.text}`);
}

function lineRef(over: Partial<LineRef>): LineRef {
  return {
    ident: 'x',
    col: null,
    targetId: 'method:x',
    uncertain: false,
    outside: false,
    title: '',
    ...over,
  };
}

/** Which token an overlay ref claims — the whole point of the atomisation. */
function claimedText(result: HighlightResult, line: number, ref: LineRef): string | undefined {
  const tokens = tokensOf(result, line);
  const claimed = assignRefs(tokens, [ref]);
  const [index] = [...claimed.keys()];
  return index === undefined ? undefined : tokens[index]?.text;
}

describe('which languages classify', () => {
  it('answers for every language the engine indexes, without throwing', () => {
    for (const language of LANGUAGES) {
      expect(() => grammarFor(language)).not.toThrow();
    }
    // The ones the classification is measured on all have a grammar.
    for (const language of ['typescript', 'go', 'python', 'rust', 'swift', 'csharp', 'ruby', 'php']) {
      expect(isHighlightable(language)).toBe(true);
    }
  });

  it('answers null rather than throwing for a language this build never heard of', () => {
    expect(grammarFor('some-future-language')).toBeNull();
    expect(grammarFor(undefined)).toBeNull();
    expect(grammarFor('')).toBeNull();
  });

  it('reads a single-file component through its script block', () => {
    // A .svelte file has no grammar of its own; its symbols live in <script>
    // and the extractor hands those to TypeScript. The classifier follows.
    expect(grammarFor('svelte')).toBe('typescript');
    const regions = syntaxRegionsFor('<p>{x}</p>\n<script lang="ts">\nlet x = 1;\n</script>\n', 'svelte');
    expect(regions).toHaveLength(1);
    expect(regions?.[0]?.language).toBe('typescript');
  });

  it('has no grammar for the formats that only have file-level extraction', () => {
    for (const language of ['yaml', 'xml', 'properties', 'twig', 'unknown']) {
      expect(grammarFor(language)).toBeNull();
    }
  });
});

describe('classification', () => {
  beforeAll(() => clearHighlightCache());

  it('reads TypeScript with the classes the theme paints', async () => {
    const result = await highlightLines(['const answer = 42; // note'], {
      language: 'typescript',
    });
    expect(result.engine).toBe('tree-sitter');
    expect(result.grammar).toBe('typescript');
    expect(result.classes).toEqual([...TOKEN_CLASSES]);
    const rendered = shape(result, 0);
    expect(rendered).toContain('keyword:const');
    expect(rendered).toContain('ident:answer');
    expect(rendered).toContain('number:42');
    expect(rendered).toContain('comment:// note');
  });

  it('reads a # comment as a comment in Python and as code in TypeScript', async () => {
    const python = await highlightLines(['x = 1  # note'], { language: 'python' });
    expect(shape(python, 0).at(-1)).toBe('comment:# note');

    const ts = await highlightLines(['x = 1  # note'], { language: 'typescript' });
    expect(shape(ts, 0).at(-1)).not.toBe('comment:# note');
  });

  it('carries a block comment across lines within one slice', async () => {
    const result = await highlightLines(['/* open', 'still comment', 'done */ const x = 1;'], {
      language: 'typescript',
    });
    expect(shape(result, 1)).toEqual(['comment:still comment']);
    expect(shape(result, 2)[0]).toBe('comment:done */');
    expect(shape(result, 2)).toContain('keyword:const');
  });

  it('reads Go, which has its own idea of what a keyword is', async () => {
    const result = await highlightLines(['func Greet(name string) string {'], { language: 'go' });
    expect(shape(result, 0)).toContain('keyword:func');
    expect(shape(result, 0)).toContain('def:Greet');
  });

  it('reads ArkTS with its own grammar, not TypeScript’s', async () => {
    const result = await highlightLines(['@Entry struct Index { build() {} }'], {
      language: 'arkts',
    });
    expect(result.engine).toBe('tree-sitter');
    expect(result.grammar).toBe('arkts');
  });

  it('does not read a type annotation’s `string` as a string literal', async () => {
    // An anonymous tree-sitter node's type IS its text, so `string` in a
    // signature arrives as a node literally typed `string`. Reading that as a
    // string literal greys out half of every signature in TypeScript and PHP.
    for (const [language, line] of [
      ['typescript', 'function put(key: string): void {}'],
      ['php', '<?php function put(string $key): void {}'],
    ] as const) {
      const result = await highlightLines([line], { language });
      expect(shape(result, 0)).toContain('type:string');
      expect(shape(result, 0)).not.toContain('string:string');
    }
  });

  it('paints a built-in type the same way in every language', async () => {
    // The grammars disagree: `string` is a `type_identifier` in Go and an
    // anonymous token inside a `predefined_type` in TypeScript. Left alone that
    // is one word painting two ways on the same screen.
    for (const [language, line] of [
      ['typescript', 'let a: string;'],
      ['go', 'var a string'],
      ['csharp', 'string a;'],
      ['rust', 'let a: u32 = 1;'],
    ] as const) {
      const rendered = shape(await highlightLines([line], { language }), 0);
      expect(rendered.some((t) => t.startsWith('type:'))).toBe(true);
      expect(rendered.some((t) => t === 'keyword:string' || t === 'keyword:u32')).toBe(false);
    }
  });

  it('keeps a template literal’s interpolated call as code, so it can link', async () => {
    const line = 'const s = `n=${store.size()} done`;';
    const result = await highlightLines([line], { language: 'typescript' });
    expect(shape(result, 0)).toContain('ident:size');
    expect(claimedText(result, 0, lineRef({ ident: 'size' }))).toBe('size');
  });

  it('marks a definition’s own name, from the extractor’s tables', async () => {
    const cases: [string, string, string][] = [
      ['typescript', 'export class Store {}', 'Store'],
      ['python', 'def put(self):', 'put'],
      ['rust', 'pub fn put(&self) {}', 'put'],
      ['ruby', 'class Store', 'Store'],
      ['csharp', 'public class Store {}', 'Store'],
      ['swift', 'final class Store {}', 'Store'],
    ];
    for (const [language, line, name] of cases) {
      const result = await highlightLines([line], { language });
      expect(shape(result, 0)).toContain(`def:${name}`);
    }
  });

  it('emits one entry per source line, always', async () => {
    const lines = ['a();', '', 'b();', ''];
    const result = await highlightLines(lines, { language: 'typescript' });
    // The code block indexes rows positionally: one short answer and every
    // line below it renders the wrong source.
    expect(result.lines).toHaveLength(lines.length);
    expect(result.lines[1]).toEqual([]);
  });

  it('reproduces every line of a real file exactly', async () => {
    // The code block renders these tokens and nothing else, so a dropped or
    // duplicated character is a corrupted file on screen — silently.
    const file = path.join(__dirname, '..', 'src', 'ui-server', 'api', 'source.ts');
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const result = await highlightLines(lines, { language: 'typescript' });
    expect(result.engine).toBe('tree-sitter');
    result.lines.forEach((row, i) => {
      expect(row.map(([, text]) => text).join('')).toBe(lines[i]);
    });
  });

  it('classifies a component’s script and leaves its markup plain', async () => {
    const lines = [
      '<script lang="ts">',
      '  let count = 0;',
      '</script>',
      '',
      '<button onclick={bump}>{count}</button>',
    ];
    const result = await highlightLines(lines, { language: 'svelte' });
    expect(result.engine).toBe('tree-sitter');
    expect(shape(result, 1)).toContain('keyword:let');
    // The markup still splits into identifiers, so a call site in it links.
    expect(claimedText(result, 4, lineRef({ ident: 'bump' }))).toBe('bump');
    expect(result.lines.map((row) => row.map(([, t]) => t).join(''))).toEqual(lines);
  });
});

describe('the plain fallback', () => {
  beforeAll(() => clearHighlightCache());

  it('answers plain, with a reason, for a language no grammar covers', async () => {
    const result = await highlightLines(['whatever this is'], { language: 'unknown' });
    expect(result.engine).toBe('plain');
    expect(result.grammar).toBeNull();
    expect(result.reason).toBeTruthy();
    expect(result.lines).toHaveLength(1);
  });

  it('still splits identifiers when it cannot highlight, so the links land', async () => {
    const result = await highlightLines(['  return this.mutex.withLock();'], {
      language: 'unknown',
    });
    expect(claimedText(result, 0, lineRef({ ident: 'withLock', col: 9 }))).toBe('withLock');
  });

  it('refuses to classify a minified line rather than wedging on it', async () => {
    const enormous = 'a'.repeat(MAX_HIGHLIGHT_CHARS + 1);
    const result = await highlightLines([enormous], { language: 'javascript' });
    expect(result.engine).toBe('plain');
    expect(result.reason).toMatch(/minified/);
    // The source still comes back whole — that is the part that matters.
    expect(result.lines[0]?.map(([, text]) => text).join('')).toHaveLength(enormous.length);
  });

  it('answers plain for a component whose script block is empty', async () => {
    const result = await highlightLines(['<p>hello</p>'], { language: 'svelte' });
    expect(result.engine).toBe('plain');
    expect(result.lines[0]?.map(([, text]) => text).join('')).toBe('<p>hello</p>');
  });
});

describe('graph links land on the right token', () => {
  beforeAll(() => clearHighlightCache());

  it('marks the callee, not the receiver the recorded column points at', async () => {
    // The recorded column is the start of the calling EXPRESSION — `this` —
    // and the underline has to end up on `withLock`.
    const line = '    return this.indexMutex.withLock(async () => {';
    const result = await highlightLines([line], { language: 'typescript' });
    expect(claimedText(result, 0, lineRef({ ident: 'withLock', col: line.indexOf('this') }))).toBe(
      'withLock'
    );
  });

  it('lands on a real call site in the engine’s own src/index.ts', async () => {
    const file = path.join(__dirname, '..', 'src', 'index.ts');
    const source = fs.readFileSync(file, 'utf-8').split('\n');
    // A line the engine actually contains, found rather than hard-coded, so a
    // refactor of index.ts retires this test instead of silently passing.
    const index = source.findIndex((l) => /^\s*(?:return |const \w+ = )?this\.\w+\.\w+\(/.test(l));
    expect(index).toBeGreaterThanOrEqual(0);
    const line = source[index] as string;
    const match = /this\.(\w+)\.(\w+)\(/.exec(line) as RegExpExecArray;
    const callee = match[2] as string;

    const result = await highlightLines([line], { language: 'typescript' });
    expect(claimedText(result, 0, lineRef({ ident: callee, col: line.indexOf('this') }))).toBe(
      callee
    );
  });

  it('lands on a Go method call', async () => {
    const line = '\tresult := s.repo.FindByID(ctx, id)';
    const result = await highlightLines([line], { language: 'go' });
    expect(claimedText(result, 0, lineRef({ ident: 'FindByID', col: line.indexOf('s.repo') }))).toBe(
      'FindByID'
    );
  });

  it('lands on a Python method call, not on the receiver of the same name', async () => {
    const line = '    return self.store.join(self.store.path)';
    const result = await highlightLines([line], { language: 'python' });
    expect(claimedText(result, 0, lineRef({ ident: 'join', col: line.indexOf('self') }))).toBe(
      'join'
    );
  });

  it('leaves a word inside a comment or a string alone', async () => {
    const result = await highlightLines(
      ['  // call render here', '  const s = "render";'],
      { language: 'typescript' }
    );
    expect(claimedText(result, 0, lineRef({ ident: 'render' }))).toBeUndefined();
    expect(claimedText(result, 1, lineRef({ ident: 'render' }))).toBeUndefined();
  });

  it('keeps every identifier separately claimable', async () => {
    const result = await highlightLines(['render(); render();'], { language: 'typescript' });
    const tokens = tokensOf(result, 0);
    const claimed = assignRefs(tokens, [
      lineRef({ ident: 'render', targetId: 'a' }),
      lineRef({ ident: 'render', targetId: 'b' }),
    ]);
    expect(claimed.size).toBe(2);
  });

  it('keeps a type name claimable — it is a distinct class, not an excluded one', async () => {
    const result = await highlightLines(['let store: Store = make();'], { language: 'typescript' });
    expect(shape(result, 0)).toContain('type:Store');
    expect(claimedText(result, 0, lineRef({ ident: 'Store' }))).toBe('Store');
  });

  it('reproduces the line exactly — the code block renders these tokens', async () => {
    const line = '  const s = `a ${b.c()} d`; // 1 + 2';
    const result = await highlightLines([line], { language: 'typescript' });
    expect(
      tokensOf(result, 0)
        .map((t) => t.text)
        .join('')
    ).toBe(line);
  });
});

describe('cost', () => {
  it('classifies three thousand lines of TypeScript well inside the budget', async () => {
    clearHighlightCache();
    const lines = fs
      .readFileSync(path.join(__dirname, '..', 'src', 'extraction', 'tree-sitter.ts'), 'utf-8')
      .split('\n')
      .slice(0, 3000);
    // Warm the grammar load, which is a one-off per language per process.
    await highlightLines(lines.slice(0, 5), { language: 'typescript' });
    clearHighlightCache();

    const started = Date.now();
    const result = await highlightLines(lines, { language: 'typescript' });
    const elapsed = Date.now() - started;

    expect(result.engine).toBe('tree-sitter');
    // The whole point of CG-57's swap: the TextMate grammar took ~700 ms here.
    // Generous against a loaded CI box; the dev Mac measures 24–41 ms.
    expect(elapsed).toBeLessThan(400);
  });

  it('answers a cached slice without re-classifying it', async () => {
    clearHighlightCache();
    const lines = fs
      .readFileSync(path.join(__dirname, '..', 'src', 'ui-server', 'api', 'source.ts'), 'utf-8')
      .split('\n');

    const cold = Date.now();
    await highlightLines(lines, { language: 'typescript', cacheKey: 'a:1:9999' });
    const coldMs = Date.now() - cold;

    const warm = Date.now();
    const second = await highlightLines(lines, { language: 'typescript', cacheKey: 'a:1:9999' });
    const warmMs = Date.now() - warm;

    expect(second.engine).toBe('tree-sitter');
    // The cache is what makes a re-render free: every resize, theme flip and
    // step back through the trail re-asks for the same slice.
    expect(warmMs).toBeLessThan(Math.max(20, coldMs / 4));
  });

  it('bounds the cache by total lines, not just by entry count', async () => {
    clearHighlightCache();
    const big = new Array(Math.ceil(SLICE_CACHE_LINES / 2) + 10).fill('x');
    // The entry count alone would let a reader left open on a big repo grow
    // without limit: three of these is well inside SLICE_CACHE_LIMIT and well
    // over the line budget.
    for (const key of ['one', 'two', 'three']) {
      await highlightLines(big, { language: 'unknown', cacheKey: key });
    }
    const stats = highlightCacheStats();
    expect(stats.entries).toBeLessThan(3);
    expect(stats.lines).toBeLessThanOrEqual(SLICE_CACHE_LINES);
  });

  it('keys the cache on the content, so an edited file re-classifies', async () => {
    clearHighlightCache();
    const first = await highlightLines(['const a = 1;'], {
      language: 'typescript',
      cacheKey: 'hash-one:1:1',
    });
    const second = await highlightLines(['const bbb = 2;'], {
      language: 'typescript',
      cacheKey: 'hash-two:1:1',
    });
    expect(first.lines[0]?.map(([, t]) => t).join('')).toBe('const a = 1;');
    expect(second.lines[0]?.map(([, t]) => t).join('')).toBe('const bbb = 2;');
  });
});

describe('the classifier itself', () => {
  it('covers the source with ordered, non-overlapping spans', async () => {
    const source = fs
      .readFileSync(path.join(__dirname, '..', 'src', 'ui-server', 'api', 'flow.ts'), 'utf-8')
      .slice(0, 40_000);
    await initGrammars();
    await loadGrammarsForLanguages(['typescript']);
    const parser = getParser('typescript');
    expect(parser).not.toBeNull();
    const tree = (parser as NonNullable<typeof parser>).parse(source);
    const spans = classifyTree((tree as NonNullable<typeof tree>).rootNode, source, 'typescript');

    expect(spans.length).toBeGreaterThan(1000);
    let previous = 0;
    for (const span of spans) {
      expect(span.start).toBeGreaterThanOrEqual(previous);
      expect(span.end).toBeGreaterThan(span.start);
      previous = span.end;
    }
    expect(previous).toBeLessThanOrEqual(source.length);
    // Everything the walk did not claim is whitespace the caller fills in.
    const uncovered: string[] = [];
    let at = 0;
    for (const span of spans) {
      if (span.start > at) uncovered.push(source.slice(at, span.start));
      at = span.end;
    }
    expect(uncovered.every((gap) => gap.trim() === '')).toBe(true);
  });
});
