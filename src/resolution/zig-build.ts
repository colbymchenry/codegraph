import path from 'node:path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getParser } from '../extraction/grammars';
import { zigIdentifier, zigString } from '../extraction/languages/zig';
import type { ResolutionContext } from './types';
import { LRUCache } from './lru-cache';

interface Module { root: string; imports: Map<string, Module | null> }
interface Build { modules: Module[]; artifacts: Array<{ module: Module; test: boolean }> }
const caches = new WeakMap<ResolutionContext, LRUCache<string, { source: string; build: Build }>>();
const children = (n: SyntaxNode) => n.namedChildren.filter(c => c.type !== 'comment');
function field(n: SyntaxNode | undefined, name: string): SyntaxNode | undefined {
  const list = n && children(n).find(c => c.type === 'initializer_list');
  const assignment = list && children(list).find(c => c.childForFieldName('left')?.childForFieldName('member')?.text === name);
  return assignment?.childForFieldName('right') ?? undefined;
}
function readBuild(source: string, buildFile: string): Build {
  const result: Build = { modules: [], artifacts: [] };
  const tree = getParser('zig')?.parse(source);
  if (!tree) return result;
  try {
    const build = children(tree.rootNode).find(n => n.type === 'function_declaration' && n.childForFieldName('name')?.text === 'build');
    const body = build?.childForFieldName('body');
    const builder = build && children(build).find(n => n.type === 'parameters')?.namedChild(0)?.childForFieldName('name')?.text;
    if (!body || !builder) return result;
    const vars = new Map<string, Module>();
    const module = (n: SyntaxNode | undefined): Module | undefined => {
      if (!n) return undefined;
      if (n.type === 'identifier') return vars.get(zigIdentifier(n.text));
      if (n.type === 'field_expression' && n.childForFieldName('member')?.text === 'root_module') return module(n.childForFieldName('object') ?? undefined);
      if (n.type !== 'call_expression') return undefined;
      const fn = n.childForFieldName('function');
      if (fn?.childForFieldName('object')?.text !== builder) return undefined;
      const method = fn.childForFieldName('member')?.text;
      const args = children(n).filter(c => c.id !== fn.id);
      if (['addExecutable', 'addLibrary', 'addTest'].includes(method ?? '')) {
        const root = module(field(args[0], 'root_module'));
        if (root) result.artifacts.push({ module: root, test: method === 'addTest' });
        return root;
      }
      if (method !== 'createModule' && method !== 'addModule') return undefined;
      const options = args[method === 'addModule' ? 1 : 0];
      const rootPath = field(options, 'root_source_file');
      const pathCall = rootPath?.childForFieldName('function');
      if (rootPath?.type !== 'call_expression' || pathCall?.childForFieldName('object')?.text !== builder || pathCall.childForFieldName('member')?.text !== 'path') return undefined;
      const literal = children(rootPath).find(c => c.type === 'string');
      const value = literal && zigString(literal.text);
      if (!value || path.posix.isAbsolute(value)) return undefined;
      const root = path.posix.normalize(path.posix.join(path.posix.dirname(buildFile), value));
      if (root.startsWith('../')) return undefined;
      const item = { root, imports: new Map<string, Module | null>() };
      result.modules.push(item);
      return item;
    };
    // Only unconditional top-level build statements are evidence. Never run
    // build.zig or interpret conditionals, loops, dependency downloads, helpers.
    for (const statement of children(body)) {
      if (statement.type === 'variable_declaration') {
        const parts = children(statement);
        const item = module(parts.at(-1));
        if (item && parts[0]) vars.set(zigIdentifier(parts[0].text), item);
      } else if (statement.type === 'expression_statement') {
        const call = children(statement)[0];
        const fn = call?.childForFieldName('function');
        if (fn?.childForFieldName('member')?.text !== 'addImport') continue;
        const owner = module(fn.childForFieldName('object') ?? undefined);
        const args = children(call!).filter(c => c.id !== fn.id);
        const name = args[0]?.type === 'string' ? zigString(args[0].text) : undefined;
        if (owner && name) owner.imports.set(name, module(args[1]) ?? null);
      }
    }
    // Conditional registration can override earlier statements. Treat those
    // bindings as unknown instead of choosing the first textual registration.
    for (const statement of children(body)) {
      if (statement.type === 'variable_declaration' || statement.type === 'expression_statement') continue;
      const invalidate = (node: SyntaxNode): void => {
        const fn = node.type === 'call_expression' && node.childForFieldName('function');
        if (fn && fn.childForFieldName('member')?.text === 'addImport') {
          const owner = module(fn.childForFieldName('object') ?? undefined);
          if (owner) for (const key of owner.imports.keys()) owner.imports.set(key, null);
        }
        for (const child of children(node)) invalidate(child);
      };
      invalidate(statement);
    }
    return result;
  } finally { tree.delete(); }
}

/** Resolve only build registrations with a unique module ownership path. */
export function resolveZigBuildModule(name: string, from: string, context: ResolutionContext): { file: string | null; buildFile: string } | undefined {
  let directory = path.posix.dirname(from);
  let buildFile: string | undefined;
  while (true) {
    const candidate = path.posix.join(directory, 'build.zig');
    if (context.fileExists(candidate)) { buildFile = candidate; break; }
    if (directory === '.') break;
    directory = path.posix.dirname(directory);
  }
  if (!buildFile) return undefined;
  const source = context.readFile(buildFile);
  if (source === null) return { file: null, buildFile };
  let cache = caches.get(context);
  if (!cache) { cache = new LRUCache(16); caches.set(context, cache); }
  let stored = cache.get(buildFile);
  if (stored?.source !== source) { stored = { source, build: readBuild(source, buildFile) }; cache.set(buildFile, stored); }
  const build = stored!.build;
  const owns = (root: string): boolean => {
    const seen = new Set<string>();
    const queue = [root];
    while (queue.length && seen.size < 2048) {
      const file = queue.pop()!;
      if (file === from) return true;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const n of context.getNodesInFile(file)) {
        if (n.kind !== 'import' || !n.signature?.startsWith('@import') || !n.name.endsWith('.zig')) continue;
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), n.name));
        if (!next.startsWith('../') && !path.posix.isAbsolute(next)) queue.push(next);
      }
    }
    return false;
  };
  const candidates: Array<string | null> = [];
  if (name === 'root') {
    for (const root of build.artifacts) {
      const seen = new Set<Module>();
      const reachable = (m: Module): boolean => {
        if (seen.has(m)) return false;
        seen.add(m);
        return owns(m.root) || [...m.imports.values()].some(v => v !== null && reachable(v));
      };
      if (reachable(root.module)) candidates.push(root.test ? null : root.module.root);
    }
  } else {
    for (const m of build.modules) if (owns(m.root)) candidates.push(m.imports.get(name)?.root ?? null);
  }
  const unique = [...new Set(candidates)];
  return { file: unique.length === 1 && unique[0] && context.fileExists(unique[0]) ? unique[0] : null, buildFile };
}
