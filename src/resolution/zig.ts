import * as path from 'path';
import { resolveZigBuildModule } from './zig-build';
import type { Node } from '../types';
import { zigAlias, zigImportCandidates, zigSegments, zigExpressionName, type ZigTarget } from '../extraction/languages/zig';
import { getParser } from '../extraction/grammars';
import { LRUCache } from './lru-cache';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

/** Literal, source-proven resolution. Missing/ambiguous bindings never fall
 * through to a similarly named symbol in an unrelated module. */
export function resolveZigImport(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if (ref.language !== 'zig') return undefined;
  const dependencies = new Set<string>();
  let rootContext = false;
  const resolveFile = (literal: string, from: string, asset = false): string | null => {
    if (!asset && !literal.endsWith('.zig')) {
      const configured = resolveZigBuildModule(literal, from, context);
      if (configured) { dependencies.add(configured.buildFile); return configured.file; }
    }
    if (literal === 'root') {
      rootContext = true;
      // Standalone executables: only an unambiguous declared entry point is
      // evidence. Build-selected / multiple roots require module context.
      const roots = context.getNodesByName('main').filter(n => n.language === 'zig' && n.kind === 'function' &&
        n.qualifiedName === 'main' && n.isExported);
      return roots.length === 1 ? roots[0]!.filePath : null;
    }
    if (!asset && !literal.endsWith('.zig')) return null;
    if (literal.includes('\0') || path.posix.isAbsolute(literal)) return null;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), literal));
    if (target.startsWith('../')) return null;
    return context.fileExists(target) ? target : null;
  };
  const resolved = (node: Node): ResolvedRef => ({ original: ref, targetNodeId: node.id, confidence: 0.95,
    resolvedBy: 'import', metadata: { zigDependencyFiles: [...dependencies].sort(), zigRootContext: rootContext } });
  if (ref.referenceKind === 'imports') {
    const origin = context.getNodesInFile(ref.filePath).find(n => n.id === ref.fromNodeId);
    if (!origin?.signature?.startsWith('@import') && !origin?.signature?.startsWith('@embedFile')) return null;
    const target = resolveFile(ref.referenceName, ref.filePath, origin?.signature?.startsWith('@embedFile'));
    const file = target && context.getNodesInFile(target).find(n => n.kind === 'file');
    return file ? resolved(file) : null;
  }
  const visited = new Set<string>();
  const follow = (file: string, members: string[], prefix: string, external: boolean, depth: number, allowValue = false): Node | null => {
    if (depth > 32 || !members.length) return null;
    dependencies.add(file);
    const key = JSON.stringify([file, members, prefix, external, allowValue]);
    if (visited.has(key)) return null;
    visited.add(key);
    const nodes = context.getNodesInFile(file);
    const qualified = prefix ? prefix + '::' + members[0]! : members[0]!;
    const matches = nodes.filter(n => n.language === 'zig' && n.qualifiedName === qualified);
    if (matches.length !== 1) return null;
    const node = matches[0]!;
    if (external && !node.isExported && node.visibility !== 'public') return null;
    const alias = (node.kind === 'constant' || node.kind === 'type_alias')
      ? aliasesInFile(file, context).get(`${node.startLine}:${node.startColumn}`) : undefined;
    if (alias && Array.isArray(alias.members)) {
      const targetFile = alias.module ? resolveFile(alias.module, file) : file;
      if (!targetFile) return null;
      const base = alias.module && alias.members.length === 0
        ? context.getNodesInFile(targetFile).find(n => n.kind === 'file') ?? null
        : follow(targetFile, alias.members, alias.module ? '' : prefix, !!alias.module, depth + 1, true);
      if (!base) return null;
      if (members.length > 1) return follow(base.filePath, members.slice(1), base.kind === 'file' ? '' : base.qualifiedName,
        external || base.filePath !== ref.filePath, depth + 1, allowValue);
      return !allowValue && ref.referenceKind === 'calls' && base.kind !== 'function' && base.kind !== 'method' ? null : base;
    }
    if (members.length > 1 && node.kind === 'enum_member') return follow(file, members.slice(1), prefix, external, depth + 1, allowValue);
    if (members.length > 1) return follow(file, members.slice(1), qualified, external, depth + 1, allowValue);
    if (!allowValue && ref.referenceKind === 'calls' && node.kind !== 'function' && node.kind !== 'method') return null;
    return node;
  };
  const candidate = ref.candidates?.[0];
  if (candidate) {
    let target: ZigTarget;
    if (candidate.startsWith('zig:')) {
      try { target = JSON.parse(candidate.slice(4)) as ZigTarget; } catch { return null; }
      if (!target || typeof target.module !== 'string' || !Array.isArray(target.members)) return null;
    } else {
      const separator = candidate.indexOf('::');
      if (separator < 0) return undefined;
      target = { module: candidate.slice(0, separator), members: candidate.slice(separator + 2).split('::') };
    }
    const file = resolveFile(target.module!, ref.filePath);
    if (!file) return null;
    const node = follow(file, target.members, '', true, 0);
    return node ? resolved(node) : null;
  }
  // Resolve local declarations and aliases in the nearest graph scope first.
  const members = zigSegments(ref.referenceName);
  const owner = context.getNodesInFile(ref.filePath).find(n => n.id === ref.fromNodeId);
  let prefix = owner?.qualifiedName ?? '';
  const nodes = context.getNodesInFile(ref.filePath);
  while (true) {
    const first = prefix ? prefix + '::' + members[0] : members[0];
    const binding = nodes.find(n => n.qualifiedName === first && n.language === 'zig');
    if (binding) {
      // Runtime values still use the shared receiver/type inference. An AST
      // constant with a call initializer is not a static namespace alias.
      if (members.length > 1 && (binding.kind === 'constant' || binding.kind === 'variable' || binding.kind === 'field' || binding.kind === 'property')) {
        const alias = aliasesInFile(ref.filePath, context).get(`${binding.startLine}:${binding.startColumn}`);
        if (!alias) return undefined;
        if (!alias.module && !nodes.some(n => n.name === alias.members[0])) return undefined;
      }
      const node = follow(ref.filePath, members, prefix, false, 0);
      return node ? resolved(node) : null;
    }
    if (!prefix) break;
    const separator = prefix.lastIndexOf('::');
    prefix = separator < 0 ? '' : prefix.slice(0, separator);
  }
  return undefined;
}

// Resolution workers may load only persisted nodes. Cache compact AST-derived
// bindings, never syntax trees; compare cached source so incremental syncs and
// changed aliases cannot keep stale answers. Bounded separately per context.
const bindingCaches = new WeakMap<ResolutionContext, LRUCache<string, { source: string; aliases: Map<string, ZigTarget> }>>();
function aliasesInFile(file: string, context: ResolutionContext): Map<string, ZigTarget> {
  let cache = bindingCaches.get(context);
  if (!cache) { cache = new LRUCache(16); bindingCaches.set(context, cache); }
  const source = context.readFile(file);
  if (source === null) return new Map();
  const cached = cache.get(file);
  if (cached?.source === source) return cached.aliases;
  const aliases = new Map<string, ZigTarget>();
  const tree = getParser('zig')?.parse(source);
  if (tree) {
    try {
      const visit = (node: import('web-tree-sitter').Node): void => {
        if (node.type === 'variable_declaration' && node.children.some(c => c.type === 'const')) {
          const value = node.namedChildren.filter(c => c.type !== 'comment').at(-1);
          const alias = value && zigAlias(value);
          if (value && alias) {
            const candidate = zigImportCandidates(value, zigExpressionName(value))?.[0];
            aliases.set(`${node.startPosition.row + 1}:${node.startPosition.column}`,
              candidate?.startsWith('zig:') ? JSON.parse(candidate.slice(4)) as ZigTarget : alias);
          }
        }
        for (const child of node.namedChildren) visit(child);
      };
      visit(tree.rootNode);
    } finally { tree.delete(); }
  }
  if (tree) cache.set(file, { source, aliases });
  return aliases;
}
