/**
 * Filtering candidates until one survives does not make that survivor the
 * target. When the call site's own name comes from a bare import — `resolve`
 * from `node:path` — the real target is external and absent from the graph, so
 * the last project symbol standing must not inherit the call.
 *
 * matchFuzzy is driven directly. Which strategy reaches a given ref depends on
 * how many same-named symbols the repo holds and on what the earlier stages of
 * matchReference make of them, so a source fixture pins the pipeline rather
 * than this guard. On real trees the shape routes through fuzzy as a
 * case-insensitive match — `EvaluatedModules` from `vite/module-runner` onto
 * vitest's `VitestMocker::evaluatedModules`, `Bundle` from `magic-string` onto
 * a svelte build script's `bundle`.
 */

import { describe, it, expect } from 'vitest';
import { matchFuzzy } from '../src/resolution/name-matcher';
import type { Node } from '../src/types';
import type { ImportMapping, ResolutionContext, UnresolvedRef } from '../src/resolution/types';

/** vite's `pluginContainer.ts:resolve` — the sole survivor of the filters. */
const SURVIVOR: Node = {
  id: 'm:resolve',
  kind: 'method',
  name: 'resolve',
  qualifiedName: 'PluginContainer::resolve',
  filePath: 'packages/vite/src/node/server/pluginContainer.ts',
  language: 'typescript',
  startLine: 10,
  endLine: 20,
  startColumn: 0,
  endColumn: 0,
  updatedAt: 0,
};

function contextWith(
  imports: ImportMapping[],
  candidate = SURVIVOR,
  localLinkNames?: Set<string>
): ResolutionContext {
  return {
    getWorkspacePackages: () => (localLinkNames ? { byName: new Map(), localLinkNames } : null),
    getNodesInFile: () => [],
    getNodesByName: () => [candidate],
    getNodesByLowerName: () => [candidate],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getFileLines: () => [],
    getProjectRoot: () => '',
    getAllFiles: () => [],
    getImportMappings: () => imports,
  } as unknown as ResolutionContext;
}

const imported = (source: string): ImportMapping[] => [
  { localName: 'resolve', exportedName: 'resolve', source, isDefault: false, isNamespace: false },
];

const callTo = (language: UnresolvedRef['language']): UnresolvedRef => ({
  fromNodeId: 'f:outDir',
  referenceName: 'resolve',
  referenceKind: 'calls',
  line: 4,
  column: 2,
  filePath: 'playground/css/vite.config.js',
  language,
});

describe('matchFuzzy declines a lone survivor bound to a bare import', () => {
  it('declines a node: builtin', () => {
    expect(matchFuzzy(callTo('javascript'), contextWith(imported('node:path')))).toBeNull();
  });

  it('declines a bare npm specifier', () => {
    expect(matchFuzzy(callTo('javascript'), contextWith(imported('rollup')))).toBeNull();
  });

  it('still matches when the binding is a relative import the resolver could not follow', () => {
    const res = matchFuzzy(callTo('javascript'), contextWith(imported('./generated/chunks')));
    expect(res?.targetNodeId).toBe('m:resolve');
    expect(res?.resolvedBy).toBe('fuzzy');
  });

  // vite's playground/tsconfig.json declares `"paths": { "~utils": [...] }` —
  // a nested tsconfig the alias loader never reads — so shape is the only
  // signal that these are local. npm names cannot start with any of them.
  it.each(['~utils', '~/utils', '#types/hmrPayload', '$lib/stores'])(
    'still matches a local specifier with no slash after its prefix: %s',
    (source) => {
      const res = matchFuzzy(callTo('javascript'), contextWith(imported(source)));
      expect(res?.targetNodeId).toBe('m:resolve');
      expect(res?.resolvedBy).toBe('fuzzy');
    },
  );

  // vitest's `test/browser/package.json` declares `"@vitest/bundled-lib":
  // "link:./bundled-lib"`, a directory its `test/*` workspace globs do not
  // reach, so the workspace map cannot vouch for the name and only the
  // dependency protocol shows it is local.
  it('still matches a link: dependency, which is local despite its package spelling', () => {
    const linked = new Set(['@vitest/bundled-lib']);
    const res = matchFuzzy(
      callTo('javascript'),
      contextWith(imported('@vitest/bundled-lib'), SURVIVOR, linked)
    );
    expect(res?.targetNodeId).toBe('m:resolve');
  });

  it('declines a scoped package that is not linked into the project', () => {
    const linked = new Set(['@vitest/bundled-lib']);
    expect(
      matchFuzzy(callTo('javascript'), contextWith(imported('@vitest/mocker'), SURVIVOR, linked))
    ).toBeNull();
  });

  it('still matches when the name is bound by no import at all', () => {
    const res = matchFuzzy(callTo('javascript'), contextWith([]));
    expect(res?.targetNodeId).toBe('m:resolve');
  });

  it('leaves languages whose own modules are imported by absolute name alone', () => {
    // `from os import path` and `from myapp.util import path` are the same
    // shape, so the bare test cannot tell external from internal here.
    const pythonRef = { ...callTo('python'), filePath: 'app/main.py' };
    const pythonNode = { ...SURVIVOR, language: 'python' as const };
    const res = matchFuzzy(pythonRef, contextWith(imported('os'), pythonNode));
    expect(res?.targetNodeId).toBe('m:resolve');
  });
});
