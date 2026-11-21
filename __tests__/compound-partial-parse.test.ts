import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['javascript', 'typescript', 'csharp', 'cfml', 'cfscript', 'cfquery']);
});

describe('compound files retain partial-parse diagnostics (#3019)', () => {
  it.each([
    ['Svelte script', 'Page.svelte', '<h1>Page</h1>\n<script lang="ts">\nfunction survive() { return 1; }\nconst broken = ;\n</script>'],
    ['Vue script', 'Page.vue', '<template><h1>Page</h1></template>\n<script setup lang="ts">\nfunction survive() { return 1; }\nconst broken = ;\n</script>'],
    ['Astro frontmatter', 'Page.astro', '\n---\nfunction survive() { return 1; }\nconst broken = ;\n---\n<h1>Page</h1>'],
    ['Astro script', 'Page.astro', '<h1>Page</h1>\n<script>\nfunction survive() { return 1; }\nconst broken = ;\n</script>'],
    ['CFML bare script', 'Page.cfc', 'component {\nfunction survive() { return 1; }\nvar broken = ;\n}'],
  ])('keeps a surviving symbol and the %s warning', (_label, file, source) => {
    const result = extractFromSource(file, source);
    expect(result.nodes.some((node) => node.name === 'survive')).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'partial_parse', filePath: file }),
    ]);
  });

  it.each([
    ['Svelte', 'Page.svelte', '<script context="module">function survive() { return 1; }</script>\n<script>\nbroken(1, ;\nother();\n</script>', 2],
    ['Vue', 'Page.vue', '<script>export function survive() { return 1; }</script>\n<script setup>\nbroken(1, ;\nother();\n</script>', 2],
    ['Astro frontmatter', 'Page.astro', '---\nbroken(1, ;\nother();\n---\n<script>function survive() { return 1; }</script>', 2],
    ['Astro script', 'Page.astro', '---\nfunction survive() { return 1; }\n---\n<script>\nbroken(1, ;\nother();\n</script>', 4],
  ] as const)('reports a declaration-free malformed %s block without claiming the host lost its symbols', (_label, file, source, line) => {
    const result = extractFromSource(file, source);
    expect(result.nodes).toContainEqual(expect.objectContaining({ name: 'Page', kind: 'component' }));
    expect(result.nodes.some((node) => node.name === 'survive')).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'partial_parse', filePath: file, line, message: expect.stringContaining(`embedded code near line ${line}`) }),
    ]);
    expect(result.errors[0]!.message).not.toMatch(/no symbols|contributes nothing/);
  });

  it.each([
    ['C#', 'Page.razor', '<h1>Page</h1>\n@code {\nvoid Survive() { external(); }\nint broken = ;\n}', 3, 'C# block'],
    ['C# with a multiline directive', 'Page.razor', '<h1>Page</h1>\n@code\n{\nvoid Survive() { external(); }\nint broken = ;\n}', 4, 'C# block'],
    ['JavaScript', 'Page.cshtml', '<h1>Page</h1>\n<script>\nfunction survive() { external(); }\nconst broken = ;\n</script>', 3, '<script>'],
    ['TypeScript with multiline attributes', 'Page.cshtml', '<h1>Page</h1>\n<script\n  lang="ts">\nfunction survive() { external(); }\nconst broken = ;\n</script>', 4, '<script>'],
  ] as const)('keeps the Razor %s warning beside its surviving calls', (_label, file, source, callLine, blockLabel) => {
    const result = extractFromSource(file, source);
    expect(result.nodes.some((node) => node.kind === 'component' && node.name === 'Page')).toBe(true);
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ referenceName: 'external', line: callLine }));
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'partial_parse', filePath: file, line: 2, message: expect.stringContaining(blockLabel) }),
    ]);
  });

  it('parses a clean Razor statement block as statements without reporting class-member errors', () => {
    const result = extractFromSource('Page.cshtml', '<h1>Page</h1>\n@{ ViewData["Title"] = "Home"; external(); }');
    expect(result.errors).toEqual([]);
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ referenceName: 'external', line: 2 }));
  });

  it('does not parse a C# block inside a Razor comment', () => {
    const result = extractFromSource('Page.razor', '<h1>Page</h1>\n@*\n@code { int broken = ; void Ghost() { hidden(); } }\n*@');
    expect(result.errors).toEqual([]);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'hidden')).toBe(false);
  });

  it('reports a malformed Razor script without declarations as a failed block of a surviving component', () => {
    const result = extractFromSource('Page.cshtml', '<h1>Page</h1>\n<script>\ndoThing(1, ;\nother();\n</script>');
    expect(result.nodes.some((node) => node.kind === 'component')).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'partial_parse', line: 2, message: expect.stringContaining('<script>') }),
    ]);
    expect(result.errors[0]!.message).not.toMatch(/no symbols|contributes nothing/);
  });

  it('names a malformed CFML script block even when its method survives', () => {
    const result = extractFromSource('Page.cfc', '<cfcomponent>\n<cfscript>\nfunction survive() { return 1; }\nvar broken = ;\n</cfscript>\n</cfcomponent>');
    expect(result.nodes).toContainEqual(expect.objectContaining({ name: 'survive', kind: 'method', startLine: 3 }));
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'partial_parse', line: 2, message: expect.stringContaining('<cfscript> at line 2') }),
    ]);
  });

  it('retains malformed CFML tag diagnostics beside surviving declarations', () => {
    const result = extractFromSource('Page.cfc', '<cfcomponent>\n<cffunction name="survive"><cfreturn 1></cffunction>\n<cfset broken = >\n</cfcomponent>');
    expect(result.nodes.some((node) => node.name === 'survive')).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'partial_parse', filePath: 'Page.cfc' }),
    ]);
  });

  it('retains a malformed CFML attribute expression that the tag parser treats as text', () => {
    const result = extractFromSource('Page.cfc', '<cfcomponent>\n<cffunction name="survive"><cfreturn 1></cffunction>\n<cfloop condition="function() { external(); var bad = ; }">\n</cfloop>\n</cfcomponent>');
    expect(result.nodes.some((node) => node.name === 'survive')).toBe(true);
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ referenceName: 'external', line: 3 }));
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'partial_parse', filePath: 'Page.cfc', message: expect.stringContaining('tag expressions') }),
    ]);
  });

  it('keeps clean CFML tag conditions and expressions free of warnings', () => {
    const result = extractFromSource('Page.cfc', '<cfcomponent>\n<cffunction name="survive">\n<cfset value = external()>\n<cfloop condition="hasNext()"><cfset advance()></cfloop>\n<cfreturn value>\n</cffunction>\n</cfcomponent>');
    expect(result.unresolvedReferences.map((ref) => ref.referenceName)).toEqual(expect.arrayContaining(['external', 'hasNext', 'advance']));
    expect(result.errors).toEqual([]);
  });

  it('keeps whole-file parse_error for malformed CFML markup with no symbols', () => {
    const result = extractFromSource('Page.cfm', '<cfset broken = >');
    expect(result.nodes.filter((node) => node.kind !== 'file')).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'parse_error', filePath: 'Page.cfm' }),
    ]);
  });
});
