/**
 * A Vue SFC's `<script lang="tsx">` is TSX, and is parsed with the TSX
 * grammar (#2570). It used to fall through to JavaScript: a macro-only script
 * like `withDefaults(defineProps<T>(), …)` reported "parse produced no
 * symbols", and a script with any other declaration hid the same broken parse
 * because that warning only fires when nothing survives.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { syntaxRegionsFor } from '../src/extraction/syntax-tokens';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const MACRO_ONLY = `<template><h1>{{ title }}</h1></template>
<script setup lang="tsx">
withDefaults(defineProps<{ title?: string }>(), { title: 'Hello' });
</script>
`;

// TypeScript types and JSX together: only the TSX grammar reads this cleanly,
// and the extra declarations keep the "no symbols" warning from firing either way.
const TYPES_AND_JSX = `<template><Row /></template>
<script setup lang="tsx">
interface RowProps { label: string }
const props = defineProps<RowProps>();
const Row = (p: RowProps) => <span class="row">{shout(p.label)}</span>;
function shout(s: string): string { return s.toUpperCase(); }
</script>
`;

/** The script body of a single-script SFC, as the viewer locates it. */
function scriptRegion(source: string) {
  const regions = syntaxRegionsFor(source, 'vue');
  expect(regions).toHaveLength(1);
  const region = regions![0]!;
  return { language: region.language, body: source.slice(region.start, region.end) };
}

describe('Vue <script lang="tsx">', () => {
  it('parses a macro-only script without a parse warning', () => {
    const result = extractFromSource('Title.vue', MACRO_ONLY);
    expect(result.errors.filter((e) => e.code === 'parse_error')).toEqual([]);
  });

  it('reads the script with the TSX grammar, which parses it without errors', () => {
    for (const source of [MACRO_ONLY, TYPES_AND_JSX]) {
      const { language, body } = scriptRegion(source);
      expect(language).toBe('tsx');
      const tree = getParser('tsx')!.parse(body)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
      } finally {
        tree.delete();
      }
    }
  });

  it('extracts TypeScript declarations and calls made inside JSX', () => {
    const result = extractFromSource('Row.vue', TYPES_AND_JSX);
    const find = (kind: string, name: string) => result.nodes.find((n) => n.kind === kind && n.name === name);
    expect(find('interface', 'RowProps')).toBeDefined();
    expect(find('function', 'shout')).toBeDefined();
    const row = find('function', 'Row');
    expect(row).toBeDefined();
    expect(
      result.unresolvedReferences.some(
        (r) => r.fromNodeId === row!.id && r.referenceName === 'shout' && r.referenceKind === 'calls'
      )
    ).toBe(true);
    expect(result.errors.filter((e) => e.code === 'parse_error')).toEqual([]);
  });

  it('reads lang the same way in the extractor and the viewer, whatever its case or quotes', () => {
    for (const attr of [`lang="TSX"`, `lang='tsx'`]) {
      const source = TYPES_AND_JSX.replace('lang="tsx"', attr);
      expect(scriptRegion(source).language).toBe('tsx');
      const result = extractFromSource('Row.vue', source);
      expect(result.nodes.some((n) => n.kind === 'interface' && n.name === 'RowProps')).toBe(true);
      expect(result.errors.filter((e) => e.code === 'parse_error')).toEqual([]);
    }
    const ts = `<script setup lang="TS">\ninterface P { a: string }\n</script>\n`;
    expect(scriptRegion(ts).language).toBe('typescript');
    expect(extractFromSource('C.vue', ts).nodes.some((n) => n.kind === 'interface' && n.name === 'P')).toBe(true);
  });

  it('still reads lang="ts" as TypeScript and no lang as JavaScript', () => {
    const ts = `<script setup lang="ts">\nconst n: number = 1;\n</script>\n`;
    const js = `<script setup>\nconst n = 1;\n</script>\n`;
    expect(scriptRegion(ts).language).toBe('typescript');
    expect(scriptRegion(js).language).toBe('javascript');
    expect(extractFromSource('A.vue', ts).nodes.some((n) => n.name === 'n')).toBe(true);
    expect(extractFromSource('B.vue', js).nodes.some((n) => n.name === 'n')).toBe(true);
  });
});
