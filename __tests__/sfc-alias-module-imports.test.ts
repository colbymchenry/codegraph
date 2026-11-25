/**
 * An import statement's module reference links the importing file to the file
 * it names: from a Vue, Svelte or Astro component as from a script, and for a
 * scoped package a `tsconfig` path maps to a project file. Before, a
 * component's `import { x } from '../lib/util'` and a script's `import { x }
 * from '@acme/common'` bound `x` through that file while the statement itself
 * linked nothing, so the module never counted the importer as a dependent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** The files a file's import statements link it to (its module edges, not its calls). */
function moduleImports(graph: CodeGraph, file: string): string[] {
  const ids = graph.getNodesInFile(file).map((n) => n.id);
  return [...new Set(graph.getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'imports' && e.target.startsWith('file:'))
    .map((e) => e.target.slice('file:'.length)))].sort();
}

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sfc-alias-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

describe('an import links the importing file to the module file', () => {
  it('from a Vue, Svelte or Astro component, by relative path', async () => {
    const graph = await index({
      'package.json': '{"name":"app"}',
      'src/lib/util.ts': 'export function format(s: string) { return s; }\n',
      'src/components/Card.vue':
        '<script setup lang="ts">\nimport { format } from \'../lib/util\';\nconst title = format(\'x\');\n</script>\n<template><div>{{ title }}</div></template>\n',
      'src/components/Badge.svelte':
        '<script lang="ts">\n  import { format } from \'../lib/util\';\n  const label = format(\'y\');\n</script>\n<span>{label}</span>\n',
      'src/pages/index.astro':
        '---\nimport { format } from \'../lib/util\';\nconst heading = format(\'z\');\n---\n<h1>{heading}</h1>\n',
    });
    for (const component of ['src/components/Card.vue', 'src/components/Badge.svelte', 'src/pages/index.astro']) {
      expect(moduleImports(graph, component), component).toEqual(['src/lib/util.ts']);
    }
  }, 120_000);

  it('for a scoped package a tsconfig path maps to a project file', async () => {
    const graph = await index({
      'package.json': '{"name":"app"}',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@acme/common': ['./packages/common/src/index.ts'] } },
      }),
      'packages/common/src/index.ts': "export * from './debounce';\n",
      'packages/common/src/debounce.ts': 'export function debounce(fn: () => void) { return fn; }\n',
      // `useTesting` keeps the outside package's import in the file, unused.
      'apps/web/src/search.ts':
        "import { debounce } from '@acme/common';\nimport { render } from '@testing-library/react';\nexport const useTesting = render;\nexport const run = debounce(() => {});\n",
    });
    // The outside package names no project file: the file links to nothing for it.
    expect(moduleImports(graph, 'apps/web/src/search.ts')).toEqual(['packages/common/src/index.ts']);
    expect(graph.getFileDependents('packages/common/src/index.ts')).toEqual(['apps/web/src/search.ts']);
  }, 120_000);
});
