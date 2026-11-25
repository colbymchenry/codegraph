/**
 * TypeScript's node16/nodenext/bundler resolution writes the EMITTED extension
 * in a relative specifier (`./util.js` for `util.ts`). The import resolver must
 * map that back to the source file that is actually in the repo; otherwise the
 * imported names fall through to bare-name matching and a method that wraps a
 * same-named import resolves to itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { resolveImportPath } from '../src/resolution/import-resolver';
import type { ResolutionContext } from '../src/resolution';

function contextWithFiles(files: string[]): ResolutionContext {
  const set = new Set(files);
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: (p: string) => set.has(p),
    readFile: () => null,
    getProjectRoot: () => '/test',
    getAllFiles: () => files,
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  } as unknown as ResolutionContext;
}

describe('emitted-extension import specifiers (`./x.js` naming `x.ts`)', () => {
  it('maps a relative .js specifier onto the .ts source', () => {
    const ctx = contextWithFiles(['shared/engine.ts', 'shared/util.ts']);
    expect(resolveImportPath('./util.js', 'shared/engine.ts', 'typescript', ctx)).toBe('shared/util.ts');
  });

  it('prefers a real .js file over the remap when both exist', () => {
    const ctx = contextWithFiles(['shared/engine.ts', 'shared/util.js', 'shared/util.ts']);
    expect(resolveImportPath('./util.js', 'shared/engine.ts', 'typescript', ctx)).toBe('shared/util.js');
  });

  it('maps .jsx, .mjs and .cjs onto their TypeScript sources', () => {
    const ctx = contextWithFiles(['app/a.tsx', 'app/View.tsx', 'app/esm.mts', 'app/cjs.cts']);
    expect(resolveImportPath('./View.jsx', 'app/a.tsx', 'tsx', ctx)).toBe('app/View.tsx');
    expect(resolveImportPath('./esm.mjs', 'app/a.tsx', 'tsx', ctx)).toBe('app/esm.mts');
    expect(resolveImportPath('./cjs.cjs', 'app/a.tsx', 'tsx', ctx)).toBe('app/cjs.cts');
  });

  it('maps an aliased .js specifier through tsconfig paths', () => {
    const files = ['src/main.ts', 'src/lib/util.ts'];
    const ctx = {
      ...contextWithFiles(files),
      getProjectAliases: () => ({
        baseUrl: '/test',
        patterns: [{ prefix: '@/', suffix: '', hasWildcard: true, replacements: ['src/*'] }],
      }),
    } as unknown as ResolutionContext;
    expect(resolveImportPath('@/lib/util.js', 'src/main.ts', 'typescript', ctx)).toBe('src/lib/util.ts');
  });

  it('leaves a specifier that names no source unresolved', () => {
    const ctx = contextWithFiles(['shared/engine.ts']);
    expect(resolveImportPath('./missing.js', 'shared/engine.ts', 'typescript', ctx)).toBeNull();
  });

  it('does not remap for a language without TypeScript emit (python)', () => {
    const ctx = contextWithFiles(['pkg/a.py', 'pkg/b.ts']);
    expect(resolveImportPath('./b.js', 'pkg/a.py', 'python', ctx)).toBeNull();
  });
});

describe('end to end: a wrapper method calling the same-named import it wraps', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-emitted-spec-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = null;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows can still hold the SQLite handle for a moment; the OS temp dir is swept anyway.
    }
  });

  it('links the call to the imported function, not to the method itself', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'template.ts'),
      'export function renderDockStyles(): string {\n  return ".dock {}";\n}\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'sidebar.ts'),
      [
        'import { renderDockStyles } from "./template.js";',
        '',
        'export class Sidebar {',
        '  renderDockStyles(): string {',
        '    return renderDockStyles();',
        '  }',
        '}',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const method = cg.getNodesByKind('method').find((n) => n.name === 'renderDockStyles');
    const fn = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'renderDockStyles' && n.filePath === 'template.ts');
    expect(method).toBeDefined();
    expect(fn).toBeDefined();
    const targets = cg
      .getOutgoingEdges(method!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => e.target);
    expect(targets).toContain(fn!.id);
    expect(targets).not.toContain(method!.id);
  });
});
