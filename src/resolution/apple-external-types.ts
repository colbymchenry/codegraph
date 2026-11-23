import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { loadAppleExternalTypes } from '../project-config';
import { isSwiftExtension } from './swift-type-visibility';

interface AppleType {
  module: 'Foundation' | 'UIKit';
  objc: string;
  swift: string;
  parent?: string;
}

// 只记录稳定的公开类型关系，不复制 SDK 源码，也不扫描本机 SDK。
// 每个条目的官方说明由 documentation() 给出；增补关系时同时补回归测试。
const TYPES: readonly AppleType[] = [
  { module: 'Foundation', objc: 'NSObject', swift: 'NSObject' },
  { module: 'Foundation', objc: 'NSURLProtocol', swift: 'URLProtocol', parent: 'NSObject' },
  { module: 'Foundation', objc: 'NSOperation', swift: 'Operation', parent: 'NSObject' },
  { module: 'UIKit', objc: 'UIResponder', swift: 'UIResponder', parent: 'NSObject' },
  { module: 'UIKit', objc: 'UIView', swift: 'UIView', parent: 'UIResponder' },
  { module: 'UIKit', objc: 'UIViewController', swift: 'UIViewController', parent: 'UIResponder' },
  { module: 'UIKit', objc: 'UINavigationController', swift: 'UINavigationController', parent: 'UIViewController' },
  { module: 'UIKit', objc: 'UIControl', swift: 'UIControl', parent: 'UIView' },
  { module: 'UIKit', objc: 'UIButton', swift: 'UIButton', parent: 'UIControl' },
  { module: 'UIKit', objc: 'UIImageView', swift: 'UIImageView', parent: 'UIView' },
];
export const APPLE_EXTERNAL_TYPE_PREFIX = 'external:apple:v1:';
const PREFIX = APPLE_EXTERNAL_TYPE_PREFIX;
const MODULES = ['Foundation', 'UIKit'] as const;
const typeKinds: readonly Node['kind'][] = ['class', 'struct', 'enum', 'interface', 'protocol', 'type_alias'];
const filePath = (module: string): string => `@external/apple/${module}`;
const idOf = (type: AppleType): string => PREFIX + type.module + ':' + type.objc;
const documentation = (type: AppleType): string =>
  `https://developer.apple.com/documentation/${type.module.toLowerCase()}/${type.swift.toLowerCase()}`;

/**
 * 可选的外部继承目录，只补充仍未解析的类继承，不解析调用或猜测任意 SDK 类型。
 * 原始引用保留在数据库中，便于配置关闭、声明消失或本地同名类型出现后重新计算。
 * 外部节点使用限定名称，避免污染普通解析器的项目内同名候选集。
 */
export function refreshAppleExternalTypes(queries: QueryBuilder, context: ResolutionContext, root: string): boolean {
  const previous = MODULES.flatMap(module => queries.getNodesByFile(filePath(module)))
    .filter(node => node.id.startsWith(PREFIX));
  if (!loadAppleExternalTypes(root)) {
    if (previous.length) queries.runInTransaction(() => previous.forEach(node => queries.deleteNode(node.id)));
    return previous.length > 0;
  }

  const declarations = typeKinds.flatMap(kind => queries.getNodesByKind(kind))
    .filter(node => !node.id.startsWith(PREFIX));
  const names = new Set(declarations.filter(node => !isSwiftExtension(node, context)).map(node => node.name));
  const sources = declarations.filter(node => (node.language === 'swift' || node.language === 'objc') &&
    node.kind === 'class' && !isSwiftExtension(node, context));
  const refs = queries.getUnresolvedReferenceNamesFrom(sources.map(node => node.id), ['extends']);
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const imports = new Map<string, Set<string>>();
  const add = (type: AppleType): string => {
    const id = idOf(type);
    if (nodes.has(id)) return id;
    nodes.set(id, {
      id, kind: 'class', name: `${type.module}.${type.objc}`,
      qualifiedName: id, filePath: filePath(type.module), language: 'objc',
      startLine: 0, endLine: 0, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      signature: `External Apple type: ${type.module}.${type.swift} (Objective-C: ${type.objc})`,
      docstring: `External type catalog v1, not indexed SDK source. No SDK methods or runtime behavior are modeled. ${documentation(type)}`,
    });
    if (type.parent) {
      const parent = TYPES.find(entry => entry.objc === type.parent)!;
      edges.push({ source: id, target: add(parent), kind: 'extends', provenance: 'heuristic',
        metadata: { synthesizedBy: 'apple-external-types', catalog: 'apple-v1', external: true, documentation: documentation(type) } });
    }
    return id;
  };

  for (const source of sources) {
    const references = refs.get(source.id);
    if (!references?.length) continue;
    let modules = imports.get(source.filePath);
    if (!modules) {
      modules = new Set(queries.getNodesByFile(source.filePath).filter(node => node.kind === 'import' &&
        (source.language === 'swift' || /^#import\s*</.test(node.signature ?? '')))
        .map(node => node.name.split('/')[0]!));
      imports.set(source.filePath, modules);
    }
    for (const name of new Set(references)) {
      // 有任何本地同名声明就不补目录关系；歧义也不能靠目录替代真实声明。
      const type = TYPES.find(entry => name === entry.swift || name === entry.objc);
      if (!type || names.has(type.swift) || names.has(type.objc)) continue;
      const visible = modules.has(type.module) || (type.module === 'Foundation' && modules.has('UIKit'));
      if (!visible) continue;
      // 已存在的继承边保留项目解析结果，不追加第二个猜测基类。
      const existing = queries.getOutgoingEdges(source.id, ['extends']).some(edge => !edge.target.startsWith(PREFIX));
      if (existing) continue;
      edges.push({ source: source.id, target: add(type), kind: 'extends', line: source.startLine,
        provenance: 'heuristic', metadata: { synthesizedBy: 'apple-external-types', catalog: 'apple-v1', external: true,
          writtenName: name, documentation: documentation(type) } });
    }
  }

  const edgeKey = (edge: Edge): string => JSON.stringify([
    edge.source, edge.target, edge.kind, edge.line ?? null, edge.provenance, edge.metadata,
  ]);
  const existingEdges = queries.getIncomingEdgesTo(previous.map(node => node.id));
  if (previous.length === nodes.size && previous.every(node => nodes.has(node.id)) &&
      JSON.stringify(existingEdges.map(edgeKey).sort()) === JSON.stringify(edges.map(edgeKey).sort())) return false;

  // 目录节点不属于扫描文件；原子替换自身节点会级联清除旧关系，不改写项目节点或引用。
  queries.runInTransaction(() => {
    previous.forEach(node => queries.deleteNode(node.id));
    for (const node of nodes.values()) queries.insertNode(node);
    queries.insertEdges(edges);
  });
  return true;
}
