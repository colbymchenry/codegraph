/**
 * The Vue resolver's rules — compiler macros, Nuxt auto-imports, PascalCase
 * components — are a Vue app's scripts', never another language's: mealie's
 * Python `QueryFilterBuilder(...)` resolved to the `QueryFilterBuilder.vue`
 * component instead of the Python class it constructs.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vue-lang-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', dependencies: { vue: '^3' } }),
    'frontend/components/QueryFilterBuilder.vue': `<template><div /></template>
<script setup lang="ts">
const props = defineProps<{ value: string }>();
</script>
`,
    'backend/query.py': `class QueryFilterBuilder:
    def __init__(self, raw):
        self.raw = raw
`,
    'backend/test_query.py': `from mealie.services.query_filter.builder import QueryFilterBuilder


def test_builder():
    return QueryFilterBuilder("x")
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('the Vue resolver', () => {
  it('leaves a Python call to its own class alone', () => {
    const ids = cg.getNodesInFile('backend/test_query.py').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.filePath);
    expect(targets).not.toContain('frontend/components/QueryFilterBuilder.vue');
  });
});
