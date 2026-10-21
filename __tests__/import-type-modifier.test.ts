/**
 * TypeScript's `type` modifiers are not bindings.
 *
 * `import type { X } from './x'` used to read as a default import named
 * `type` beside `X` — every type-only import line bound `type` — so zod's
 * `type.innerType()` (a parameter named `type`) was taken for a call on an
 * import. An inline `{ util, type objectUtil }` named its binding
 * `type objectUtil`.
 *
 * A binding is any JS identifier, `$` included. The import regexes matched
 * names with `\w`, which stops at a `$`: `import items$ from './store'` and
 * `import * as ns$` yielded no binding at all, and `{ a as b$ }` bound `b`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractImportMappings, extractReExports } from '../src/resolution/import-resolver';

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

describe('import bindings whose names contain `$`', () => {
  it('default, namespace and mixed imports bind the whole name', () => {
    expect(bindings(`import items$ from './store';\n`)).toEqual(['items$<default']);
    expect(bindings(`import $store from './store';\n`)).toEqual(['$store<default']);
    expect(bindings(`import * as ns$ from './ns';\n`)).toEqual(['ns$<* ns']);
    expect(bindings(`import $, { ajax } from 'jquery';\n`)).toEqual(['$<default', 'ajax<ajax']);
    expect(bindings(`import dflt$, * as $ns from './both';\n`)).toEqual(['dflt$<default', '$ns<* ns']);
  });

  it('aliased and type-only imports bind the whole name', () => {
    expect(bindings(`import { a$ as b$, a as $b, default as items$ } from './ab';\n`)).toEqual(['b$<a$', '$b<a', 'items$<default']);
    expect(bindings(`import type $T from './t';\n`)).toEqual(['$T<default']);
    expect(bindings(`import { type $T, type U$ as V$ } from './t';\n`)).toEqual(['$T<$T', 'V$<U$']);
    // `from$` is a name, not the `from` that ends a bare `import type from …`.
    expect(bindings(`import type from$ from './t';\n`)).toEqual(['from$<default']);
  });

  it("a code generator's `${…}` is no binding", () => {
    expect(bindings("const code = `import ${name} from '${src}'`;\n")).toEqual([]);
    expect(bindings("const code = `import type ${name} from '${src}'`;\n")).toEqual([]);
  });

  it('a CommonJS destructuring binds the whole name', () => {
    expect(bindings(`const { a$: b$, a: $c, d$ } = require('./r');\n`)).toEqual(['b$<a$', '$c<a', 'd$<d$']);
  });

  it('a re-export names the whole name', () => {
    expect(extractReExports(`export { a$, $b as c$, default as $store } from './x';\n`, 'typescript')).toEqual([
      { kind: 'named', exportedName: 'a$', originalName: 'a$', source: './x' },
      { kind: 'named', exportedName: 'c$', originalName: '$b', source: './x' },
      { kind: 'named', exportedName: '$store', originalName: 'default', source: './x' },
    ]);
  });
});

describe('a `$` binding imported from another file', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it('`items$.getState().inc()` reaches the store action unless a local or parameter shadows `items$`', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-import-dollar-'));
    roots.push(root);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'shop', dependencies: { zustand: '*' } }),
      'src/store.ts': `import { create } from 'zustand';

const items$ = create((set) => ({ inc: () => set({}) }));
export default items$;
`,
      'src/util.ts': `export function helper() { return 1; }
`,
      'src/decoy.ts': `export function helper() { return 2; }
`,
      'src/use.ts': `import items$ from './store';
import * as util$ from './util';

export function clickInc() { items$.getState().inc(); }
export function shadowed() { const items$ = other(); items$.getState().inc(); }
export function param(items$: Store) { items$.getState().inc(); }
export function run() { return util$.helper(); }
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const callers = (file: string, name: string) => {
        const target = cg.getNodesInFile(file).find((n) => n.kind === 'function' && n.name === name);
        expect(target, `${file}: ${name}`).toBeDefined();
        return cg.getCallers(target!.id).filter((c) => c.edge.kind === 'calls').map((c) => c.node.name).sort();
      };
      expect(callers('src/store.ts', 'inc')).toEqual(['clickInc']);
      expect(callers('src/util.ts', 'helper')).toEqual(['run']);
      expect(callers('src/decoy.ts', 'helper')).toEqual([]);
    } finally {
      cg.close();
    }
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
