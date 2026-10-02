/**
 * TypeScript's `type` modifiers are not bindings.
 *
 * `import type { X } from './x'` used to read as a default import named
 * `type` beside `X` — every type-only import line bound `type` — so zod's
 * `type.innerType()` (a parameter named `type`) was taken for a call on an
 * import. An inline `{ util, type objectUtil }` named its binding
 * `type objectUtil`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractImportMappings } from '../src/resolution/import-resolver';

const bindings = (source: string) =>
  extractImportMappings('src/a.ts', source, 'typescript').map((m) => `${m.localName}<${m.exportedName}${m.isNamespace ? ' ns' : ''}`);

describe('import mappings and TypeScript type modifiers', () => {
  it('a type-only import binds its names, never `type`', () => {
    expect(bindings(`import type { enumUtil } from './helpers/enumUtil.js';\n`)).toEqual(['enumUtil<enumUtil']);
    expect(bindings(`import type * as z from './z';\n`)).toEqual(['z<* ns']);
    expect(bindings(`import type Foo from './foo';\n`)).toEqual(['Foo<default']);
  });

  it('an inline `type` modifier is not part of the name', () => {
    expect(bindings(`import { util, type objectUtil } from './helpers/util.js';\n`)).toEqual(['util<util', 'objectUtil<objectUtil']);
    expect(bindings(`import { type A as B } from './ab';\n`)).toEqual(['B<A']);
  });

  it('a default import that is named `type` is still one', () => {
    expect(bindings(`import type from './type';\n`)).toEqual(['type<default']);
  });
});

describe('a name imported from a package names nothing in the project', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it('halo: `type RsbuildConfig` and `type Command` are not a local `rsbuildConfig` or `command`', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-import-type-'));
    roots.push(root);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'console', dependencies: { '@rsbuild/core': '*', '@tiptap/core': '*' } }),
      'src/rsbuild.ts': `import { defineConfig, type RsbuildConfig } from '@rsbuild/core';
export function rsbuildConfig(): RsbuildConfig { return defineConfig({}); }
`,
      'src/menu.ts': `export function command() { return 1; }
`,
      'src/gap.ts': `import type { Command } from '@tiptap/core';
export function gapCursor(): Command { return () => true; }
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const targets = (file: string) =>
        cg
          .getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id), ['references', 'imports', 'type_of', 'returns'])
          .map((e) => cg.getNode(e.target)!)
          .filter((n) => n.kind !== 'file' && n.kind !== 'import')
          .map((n) => n.name);
      expect(targets('src/rsbuild.ts')).not.toContain('rsbuildConfig');
      expect(targets('src/gap.ts')).not.toContain('command');
    } finally {
      cg.close();
    }
  });
});
