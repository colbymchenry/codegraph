/**
 * Regression: "prefer same directory" component resolution must compare
 * directories at a path-segment boundary, not as a raw string prefix.
 *
 * The React/Vue/Svelte framework resolvers disambiguate same-named
 * components by preferring one in the referencing file's directory:
 *
 *   const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
 *   const sameDir = components.filter((n) => n.filePath.startsWith(fromDir));
 *
 * `startsWith(fromDir)` has no trailing-separator boundary, so a file in a
 * SIBLING directory whose name merely shares a prefix (`src/ui-kit/...`
 * vs `src/ui/...`) is wrongly treated as same-directory and can win the
 * tie — resolving a reference to the wrong component (a wrong graph edge).
 */

import { describe, it, expect } from 'vitest';
import { reactResolver } from '../src/resolution/frameworks/react';
import { svelteResolver } from '../src/resolution/frameworks/svelte';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node, Language } from '../src/types';

function makeComponent(
  id: string,
  name: string,
  filePath: string,
  language: Language = 'typescript'
): Node {
  return {
    id,
    kind: 'component',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
}

/** Minimal context: only the methods resolveComponent touches need to work. */
function makeContext(nodesByName: Record<string, Node[]>): ResolutionContext {
  return {
    getNodesByName: (name: string) => nodesByName[name] ?? [],
    getNodesInFile: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/repo',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  };
}

describe('framework same-directory preference uses a path boundary', () => {
  it('does not treat a prefix-sibling directory as the same directory', () => {
    // Reference site lives in src/ui/. Two components named Widget exist:
    // the real same-dir one in src/ui/, and a decoy in the prefix-sibling
    // src/ui-kit/. The decoy is listed FIRST so a raw-prefix match returns
    // it instead of the true same-directory component.
    const trueSameDir = makeComponent('id-ui', 'Widget', 'src/ui/Widget.tsx');
    const prefixSibling = makeComponent('id-uikit', 'Widget', 'src/ui-kit/Widget.tsx');

    const context = makeContext({ Widget: [prefixSibling, trueSameDir] });

    const ref: UnresolvedRef = {
      fromNodeId: 'caller',
      referenceName: 'Widget',
      referenceKind: 'references',
      line: 5,
      column: 0,
      filePath: 'src/ui/Card.tsx',
      language: 'typescript',
    };

    const resolved = reactResolver.resolve(ref, context);
    expect(resolved).not.toBeNull();
    // Must resolve to the component actually in src/ui/, never the
    // src/ui-kit/ sibling that only shares a string prefix.
    expect(resolved!.targetNodeId).toBe('id-ui');
  });

  it('still prefers a true same-directory component over an unrelated one', () => {
    // Sanity: the same-directory preference itself still works after the fix.
    const sameDir = makeComponent('id-same', 'Panel', 'src/ui/Panel.tsx');
    const elsewhere = makeComponent('id-other', 'Panel', 'src/widgets/Panel.tsx');

    // List the unrelated one first; the same-dir one must still win.
    const context = makeContext({ Panel: [elsewhere, sameDir] });

    const ref: UnresolvedRef = {
      fromNodeId: 'caller',
      referenceName: 'Panel',
      referenceKind: 'references',
      line: 5,
      column: 0,
      filePath: 'src/ui/Card.tsx',
      language: 'typescript',
    };

    const resolved = reactResolver.resolve(ref, context);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('id-same');
  });

  it('Svelte: prefix-sibling directory is not the same directory', () => {
    const trueSameDir = makeComponent('sv-ui', 'Widget', 'src/ui/Widget.svelte', 'svelte');
    const prefixSibling = makeComponent('sv-uikit', 'Widget', 'src/ui-kit/Widget.svelte', 'svelte');

    const context = makeContext({ Widget: [prefixSibling, trueSameDir] });

    // Svelte dispatches component resolution on `calls` refs.
    const ref: UnresolvedRef = {
      fromNodeId: 'caller',
      referenceName: 'Widget',
      referenceKind: 'calls',
      line: 5,
      column: 0,
      filePath: 'src/ui/Card.svelte',
      language: 'svelte',
    };

    const resolved = svelteResolver.resolve(ref, context);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('sv-ui');
  });
});
