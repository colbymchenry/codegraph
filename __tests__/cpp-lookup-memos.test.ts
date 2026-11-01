/**
 * Resolving a C++ reference asks about one class name strategy after strategy,
 * and a project's files include one header from hundreds of places. Each answer
 * is worked out once. These count the lookups, not the time they take.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ReferenceResolver } from '../src/resolution';
import { cppClassWritten } from '../src/resolution/cpp-supertypes';
import { resolveImportPath } from '../src/resolution/import-resolver';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

type Queries = ConstructorParameters<typeof ReferenceResolver>[1];

describe('C++ lookups', () => {
  let root: string;
  let cg: CodeGraph;
  let context: ResolutionContext;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-memos-'));
    fs.mkdirSync(path.join(root, 'include/acme'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'include/acme/base.h'), 'namespace acme { class Base {}; }\n');
    fs.writeFileSync(path.join(root, 'src/a/one.cc'), '#include "acme/base.h"\nacme::Base one;\n');
    fs.writeFileSync(path.join(root, 'src/b/two.cc'), '#include "acme/base.h"\nacme::Base two;\n');
    cg = await CodeGraph.init(root, { index: true });
    const resolver = new ReferenceResolver(root, (cg as unknown as { queries: Queries }).queries);
    resolver.initialize([]);
    context = resolver.getResolutionContext();
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('asks about a class name once for a reference', () => {
    const asked: string[] = [];
    const getNodesByName = context.getNodesByName;
    context.getNodesByName = (name) => {
      asked.push(name);
      return getNodesByName(name);
    };
    const ref: UnresolvedRef = {
      fromNodeId: 'n', referenceName: 'Base', referenceKind: 'references',
      line: 2, column: 0, filePath: 'src/a/one.cc', language: 'cpp',
    };
    const site = { scope: 'acme', file: 'src/a/one.cc', line: 2, parameters: new Set<string>() };

    const first = cppClassWritten('Base', site, ref, context);
    expect(first?.node.qualifiedName).toBe('acme::Base');
    expect(asked.length).toBeGreaterThan(0);

    asked.length = 0;
    expect(cppClassWritten('Base', site, ref, context)).toBe(first);
    expect(asked).toEqual([]);

    // A later line of the file may have a `using` this one doesn't: its own answer.
    const later = cppClassWritten('Base', { ...site, line: 3 }, { ...ref, line: 3 }, context);
    expect(later).not.toBe(first);
    expect(later?.node).toBe(first?.node);
  });

  it('searches the include directories once for a header, whichever file includes it', () => {
    const probed: string[] = [];
    const fileExists = context.fileExists;
    context.fileExists = (file) => {
      probed.push(file);
      return fileExists(file);
    };
    const inIncludeDirs = (): string[] => probed.filter((file) => file.startsWith('include/'));

    expect(resolveImportPath('acme/base.h', 'src/a/one.cc', 'cpp', context)).toBe('include/acme/base.h');
    expect(inIncludeDirs().length).toBeGreaterThan(0);

    probed.length = 0;
    expect(resolveImportPath('acme/base.h', 'src/b/two.cc', 'cpp', context)).toBe('include/acme/base.h');
    expect(inIncludeDirs()).toEqual([]);
  });
});
