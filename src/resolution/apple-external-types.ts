import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { loadAppleExternalTypes } from '../project-config';
import { isSwiftExtension } from './swift-type-visibility';

import { loadAppleSymbolGraphs, type ExternalClass } from './apple-symbol-graphs';

export const APPLE_EXTERNAL_TYPE_PREFIX = 'external:apple:';
const PREFIX = APPLE_EXTERNAL_TYPE_PREFIX + 'symbolgraph:';
const EXTERNAL_FILE = '@external/apple/symbolgraphs';
const typeKinds: readonly Node['kind'][] = ['class', 'struct', 'enum', 'interface', 'protocol', 'type_alias'];
const idOf = (type: ExternalClass): string => PREFIX + type.usr;

/** 只补未解析的基类；USR 与继承关系来自工具链，不维护类型或别名表。 */
export async function refreshAppleExternalTypes(queries: QueryBuilder, context: ResolutionContext, root: string): Promise<boolean> {
  // 兼容试用版外部节点的清理，不把旧目录作为数据源。
  const previous = [EXTERNAL_FILE, '@external/apple/Foundation', '@external/apple/UIKit']
    .flatMap(file => queries.getNodesByFile(file)).filter(node => node.id.startsWith(APPLE_EXTERNAL_TYPE_PREFIX));
  const config = loadAppleExternalTypes(root);
  if (!config) {
    if (previous.length) queries.runInTransaction(() => previous.forEach(node => queries.deleteNode(node.id)));
    return previous.length > 0;
  }
  const declarations = typeKinds.flatMap(kind => queries.getNodesByKind(kind))
    .filter(node => !node.id.startsWith(APPLE_EXTERNAL_TYPE_PREFIX));
  const names = new Set(declarations.filter(node => !isSwiftExtension(node, context)).map(node => node.name));
  const sources = declarations.filter(node => (node.language === 'swift' || node.language === 'objc') &&
    node.kind === 'class' && !isSwiftExtension(node, context));
  const refs = queries.getUnresolvedReferenceNamesFrom(sources.map(node => node.id), ['extends']);
  const imports = new Map<string, Set<string>>();
  for (const source of sources) {
    if (!refs.get(source.id)?.length || imports.has(source.filePath)) continue;
    if (queries.getOutgoingEdges(source.id, ['extends']).some(edge => !edge.target.startsWith(APPLE_EXTERNAL_TYPE_PREFIX))) continue;
    imports.set(source.filePath, new Set(queries.getNodesByFile(source.filePath)
      .filter(node => node.kind === 'import' && (source.language === 'swift' || /^#import\s*</.test(node.signature ?? '')))
      .map(node => node.name.split('/')[0]!)));
  }
  const graphs = await loadAppleSymbolGraphs(config, root, [...new Set([...imports.values()].flatMap(set => [...set]))].sort());
  const types = new Map(graphs.flatMap(graph => graph.classes.map(type => [type.usr, type] as const)));
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const metadata = { synthesizedBy: 'apple-symbolgraph', external: true, format: 'swift-symbolgraph' };
  const add = (type: ExternalClass): string => {
    const id = idOf(type);
    if (nodes.has(id)) return id;
    nodes.set(id, {
      id, kind: 'class', name: `${type.module}.${type.name}`, qualifiedName: id,
      filePath: EXTERNAL_FILE, language: 'swift',
      startLine: 0, endLine: 0, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      signature: `External SDK type: ${type.module}.${type.name}${type.objc ? ` (Objective-C: ${type.objc})` : ''}`,
      docstring: `Imported from Swift Symbol Graph; not indexed SDK source. USR: ${type.usr}. Only known class inheritance is modeled.`,
    });
    if (type.parent && type.parent !== type.usr) {
      let parent = types.get(type.parent);
      // 图中的跨模块父类可以只有编译器给出的标识和限定名称；不臆造其祖先。
      if (!parent && type.parentFallback?.includes('.')) {
        const separator = type.parentFallback.indexOf('.');
        parent = { usr: type.parent, module: type.parentFallback.slice(0, separator),
          name: type.parentFallback.slice(separator + 1), objc: /^c:objc\(cs\)([^(@]+)$/.exec(type.parent)?.[1] };
      }
      if (parent) edges.push({ source: id, target: add(parent), kind: 'extends', provenance: 'heuristic',
        metadata: { ...metadata, evidence: 'inheritsFrom', sourceUSR: type.usr, targetUSR: parent.usr } });
    }
    return id;
  };
  for (const source of sources) {
    const references = refs.get(source.id);
    const modules = imports.get(source.filePath);
    if (!references?.length || !modules) continue;
    const candidates = new Map<string, ExternalClass>();
    for (const name of new Set(references)) {
      for (const graph of graphs) {
        if (!modules.has(graph.module)) continue;
        for (const type of graph.classes) {
          if (name !== type.name && name !== type.objc) continue;
          if (names.has(type.name) || (type.objc && names.has(type.objc))) continue;
          candidates.set(type.usr, type);
        }
      }
    }
    // 一条基类引用只能落到唯一身份；不以导入顺序消解歧义。
    if (candidates.size !== 1) continue;
    if (queries.getOutgoingEdges(source.id, ['extends']).some(edge => !edge.target.startsWith(APPLE_EXTERNAL_TYPE_PREFIX))) continue;
    const type = candidates.values().next().value!;
    edges.push({ source: source.id, target: add(type), kind: 'extends', line: source.startLine, provenance: 'heuristic',
      metadata: { ...metadata, evidence: 'unresolved-superclass-name', targetUSR: type.usr } });
  }

  const edgeKey = (edge: Edge): string => JSON.stringify([
    edge.source, edge.target, edge.kind, edge.line ?? null, edge.provenance, edge.metadata,
  ]);
  const existingEdges = queries.getIncomingEdgesTo(previous.map(node => node.id));
  if (previous.length === nodes.size && previous.every(node => {
        const next = nodes.get(node.id);
        return next && node.name === next.name && node.signature === next.signature && node.docstring === next.docstring;
      }) &&
      JSON.stringify(existingEdges.map(edgeKey).sort()) === JSON.stringify(edges.map(edgeKey).sort())) return false;

  // 外部节点不属于扫描文件；原子替换自身节点会级联清除旧关系，不改写项目节点或引用。
  queries.runInTransaction(() => {
    previous.forEach(node => queries.deleteNode(node.id));
    for (const node of nodes.values()) queries.insertNode(node);
    queries.insertEdges(edges);
  });
  return true;
}
