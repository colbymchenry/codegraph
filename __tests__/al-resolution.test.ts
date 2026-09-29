import { describe, expect, it } from 'vitest';
import { ReferenceResolver } from '../src/resolution';
import { matchReference } from '../src/resolution/name-matcher';
import type { QueryBuilder } from '../src/db/queries';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

function contextFor(nodes: Node[]): ResolutionContext {
  return {
    getNodesInFile: filePath => nodes.filter(node => node.filePath === filePath),
    getNodesByName: name => nodes.filter(node => node.name === name),
    getNodesByQualifiedName: qualifiedName => nodes.filter(node => node.qualifiedName === qualifiedName),
    getNodesByKind: kind => nodes.filter(node => node.kind === kind),
    fileExists: () => true,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [...new Set(nodes.map(node => node.filePath))],
    getNodesByLowerName: lowerName => nodes.filter(
      node => node.name.toLowerCase() === lowerName.toLowerCase(),
    ),
    getImportMappings: () => [],
  };
}

function call(referenceName: string): UnresolvedRef {
  return {
    fromNodeId: 'caller',
    referenceName,
    referenceKind: 'calls',
    line: 10,
    column: 4,
    filePath: 'caller.al',
    language: 'al',
  };
}

function symbol(
  id: string,
  kind: Node['kind'],
  name: string,
  qualifiedName: string,
  filePath: string,
): Node {
  return {
    id,
    kind,
    name,
    qualifiedName,
    filePath,
    language: 'al',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
  };
}

function resolverFor(nodes: Node[]): ReferenceResolver {
  const queries = {
    getAllFilePaths: () => [...new Set(nodes.map(node => node.filePath))],
    getAllNodeNames: () => [...new Set(nodes.map(node => node.name))],
    getNodesByFile: (filePath: string) => nodes.filter(node => node.filePath === filePath),
    getNodesByName: (name: string) => nodes.filter(node => node.name === name),
    getNodesByLowerName: (name: string) => nodes.filter(
      node => node.name.toLowerCase() === name.toLowerCase(),
    ),
    getNodesByQualifiedNameExact: (qualifiedName: string) => nodes.filter(
      node => node.qualifiedName === qualifiedName,
    ),
    getNodesByKind: (kind: Node['kind']) => nodes.filter(node => node.kind === kind),
    iterateNodesByKind: function* (kind: Node['kind']) {
      yield* nodes.filter(node => node.kind === kind);
    },
    getNodeById: (id: string) => nodes.find(node => node.id === id) ?? null,
  } as unknown as QueryBuilder;
  return new ReferenceResolver('/project', queries);
}

describe('AL resolution', () => {
  it('resolves member calls case-insensitively', () => {
    const target = symbol('target', 'method', 'DoWork', 'Target::DoWork', 'target.al');

    expect(matchReference(call('service.dowork'), contextFor([target]))?.targetNodeId).toBe(target.id);
  });

  it('resolves case-insensitive AL calls through the existing production prefilter', () => {
    const target = symbol('target', 'method', 'DoWork', 'Target::DoWork', 'target.al');
    const result = resolverFor([target]).resolveAll([
      call('dowork'),
      call('service.dowork'),
    ]);

    expect(result.resolved.map(ref => ref.targetNodeId)).toEqual([target.id, target.id]);
  });

  it('resolves quoted member calls case-insensitively', () => {
    const target = symbol('target', 'method', '"Do Work"', 'Service::"Do Work"', 'target.al');

    const result = resolverFor([target]).resolveAll([call('service."do work"')]);
    expect(result.resolved[0]?.targetNodeId).toBe(target.id);
  });

  it('resolves Unicode member calls using AL identifier rules', () => {
    const target = symbol('target', 'method', 'Oa\u0301k', 'Service::Oa\u0301k', 'target.al');

    expect(matchReference(call('service.oa\u0301k'), contextFor([target]))?.targetNodeId).toBe(target.id);
  });

  it('does not treat dots inside quoted AL identifiers as member separators', () => {
    const target = symbol('target', 'method', '"Do.Work"', 'Service::"Do.Work"', 'target.al');

    expect(matchReference(call('service."do.work"'), contextFor([target]))?.targetNodeId).toBe(target.id);
    expect(resolverFor([target]).resolveAll([call('"do.work"')]).resolved[0]?.targetNodeId).toBe(target.id);
  });

  it('does not guess when a case-insensitive member name is ambiguous', () => {
    const first = symbol('first', 'method', 'DoWork', 'First::DoWork', 'first.al');
    const second = symbol('second', 'method', 'DOWORK', 'Second::DOWORK', 'second.al');

    expect(matchReference(call('service.dowork'), contextFor([first, second]))).toBeNull();
  });

  it('uses AL using directives to disambiguate object references', () => {
    const currentNamespace = symbol(
      'caller-ns',
      'namespace',
      'Contoso.Extension',
      'Contoso.Extension',
      'caller.al',
    );
    const wrong = symbol(
      'wrong',
      'class',
      'Customer',
      'Nearby.Unrelated::Customer',
      'nearby/customer.al',
    );
    const target = symbol(
      'target',
      'class',
      'Customer',
      'Microsoft.Sales::Customer',
      'base/customer.al',
    );
    const using = symbol(
      'using-sales',
      'import',
      'Microsoft.Sales',
      'Microsoft.Sales',
      'caller.al',
    );
    const ref: UnresolvedRef = {
      ...call('customer'),
      referenceKind: 'extends',
    };

    const result = resolverFor([currentNamespace, using, wrong, target]).resolveAll([ref]);
    expect(result.resolved[0]?.targetNodeId).toBe(target.id);
  });
});
