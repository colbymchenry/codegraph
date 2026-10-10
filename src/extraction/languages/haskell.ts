import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { NodeKind } from '../../types';

// Node names follow the tree-sitter-haskell grammar 0.23.1 (vendored, ABI 14).
//
// Haskell's AST shapes don't map to the generic extractor's bodyField-based
// dispatch — different node kinds use different field names for their body
// (`match` for functions, `declarations` for class/instance bodies, no field
// for data-type constructors). Every symbol-bearing top-level declaration is
// dispatched through the visitNode hook below, mirroring the Erlang
// extractor's approach.
//
// Calls are handled partly here (data constructor applications and infix
// operators via the haskell branch in extractCall) and partly by the generic
// call-extraction fallback (which reads the `function` field of `apply`
// nodes — covering bare `fn x` and qualified `Mod.fn x` calls).

/** Collapse runs of whitespace for one-line signatures. */
export function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Read the text of a `module` node as a dotted module name (`Data.List`). */
export function moduleDottedName(node: SyntaxNode, source: string): string {
  const parts: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'module_id') {
      parts.push(getNodeText(child, source));
    }
  }
  return parts.join('.');
}

/** Haddock prose without its comment markers (`-- |`, `{- | -}`, continuation `--`). */
function haddockText(node: SyntaxNode, source: string): string | undefined {
  const text = getNodeText(node, source)
    .replace(/^\{-\s*[|^]?\s*/, '')
    .replace(/-}$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*--\s?[|^]?\s?/, '').trimEnd())
    .join('\n')
    .trim();
  return text || undefined;
}

/** The haddock found walking back from `start` over plain comments; null when another node comes first. */
function haddockBackFrom(start: SyntaxNode | null, source: string): string | undefined | null {
  let sibling = start;
  while (sibling?.type === 'haddock' || sibling?.type === 'comment') {
    if (sibling.type === 'haddock') return haddockText(sibling, source);
    sibling = sibling.previousNamedSibling;
  }
  return sibling ? null : undefined;
}

/**
 * Extract a Haddock comment (`-- | ...` / `{- | ... -}`) preceding a node.
 * Haddocks are siblings of the declaration they document, except before a
 * container's first declaration: the parser attaches that one to the end of
 * the previous container (`imports`, or before `declarations` itself).
 */
export function precedingHaddock(node: SyntaxNode, source: string): string | undefined {
  const own = haddockBackFrom(node.previousNamedSibling, source);
  if (own !== undefined) return own ?? undefined;
  const container = node.parent;
  if (container?.type !== 'declarations') return undefined;
  const before = container.previousNamedSibling;
  if (before?.type === 'imports' || before?.type === 'header') {
    return haddockBackFrom(before.lastNamedChild, source) ?? undefined;
  }
  return haddockBackFrom(before, source) ?? undefined;
}

/** The preceding `signature` sibling (comments/haddocks may sit between), if it names this function. */
function precedingSignature(node: SyntaxNode, name: string, source: string): SyntaxNode | null {
  let prev = node.previousNamedSibling;
  while (prev && (prev.type === 'comment' || prev.type === 'haddock')) prev = prev.previousNamedSibling;
  if (prev?.type === 'signature') {
    const sigName = getChildByField(prev, 'name');
    if (sigName && getNodeText(sigName, source) === name) return prev;
  }
  return null;
}

// --- Exports ---
//
// A module with an export list (`module M (f, T(..)) where`) exports exactly
// the listed names; a module without one exports every top-level declaration.
// Only top-level declarations can be exported.

interface ModuleExports {
  /** null = no export list, so every top-level declaration is exported. */
  names: Set<string> | null;
  /** Types exported with all their constructors/fields: `T(..)`. */
  allChildren: Set<string>;
}

// Per-file memos are keyed by the parse tree: a new object per parse, whereas
// a path, a source text or a node id can repeat across extractions.
let exportsMemoTree: unknown = null;
let exportsMemo: ModuleExports = { names: null, allChildren: new Set() };

function rootOf(node: SyntaxNode): SyntaxNode {
  let root = node;
  while (root.parent) root = root.parent;
  return root;
}

function moduleExports(node: SyntaxNode, source: string): ModuleExports {
  const root = rootOf(node);
  if (exportsMemoTree === node.tree) return exportsMemo;
  const result: ModuleExports = { names: null, allChildren: new Set() };
  const header = root.namedChildren.find((c) => c?.type === 'header');
  const exports = header ? getChildByField(header, 'exports') : null;
  if (exports) {
    result.names = new Set();
    for (const exp of exports.namedChildren) {
      if (exp?.type !== 'export') continue;
      const named = getChildByField(exp, 'variable') ?? getChildByField(exp, 'type') ?? getChildByField(exp, 'operator');
      if (!named) continue;
      const name = getNodeText(named, source).replace(/^\((.*)\)$/, '$1');
      result.names.add(name);
      const children = getChildByField(exp, 'children');
      if (!children) continue;
      for (const child of children.namedChildren) {
        if (!child) continue;
        if (child.type === 'all_names') result.allChildren.add(name);
        else result.names.add(getNodeText(child, source));
      }
    }
  }
  exportsMemoTree = node.tree;
  exportsMemo = result;
  return result;
}

// --- Qualified references ---
//
// The resolver matches a qualified reference against node qualified names,
// which are `Module::name` (the header's namespace node is the scope). A
// Haskell reference is written `Mod.name`, usually through an import
// alias (`import Data.Map qualified as M` … `M.fromList`), so it is rewritten
// to `Data.Map::fromList` from the file's own imports.

let aliasMemoTree: unknown = null;
let aliasMemo = new Map<string, string[]>();

/** Module names each qualifier in this file can stand for: aliases, and full names. */
function moduleAliases(node: SyntaxNode, source: string): Map<string, string[]> {
  const root = rootOf(node);
  if (aliasMemoTree === node.tree) return aliasMemo;
  const aliases = new Map<string, string[]>();
  const add = (qualifier: string, module: string): void => {
    const modules = aliases.get(qualifier) ?? [];
    if (!modules.includes(module)) modules.push(module);
    aliases.set(qualifier, modules);
  };
  const imports = root.namedChildren.find((c) => c?.type === 'imports');
  for (const imp of imports?.namedChildren ?? []) {
    if (imp?.type !== 'import') continue;
    const mod = getChildByField(imp, 'module');
    if (!mod) continue;
    const module = moduleDottedName(mod, source);
    const alias = getChildByField(imp, 'alias');
    add(alias ? moduleDottedName(alias, source) : module, module);
  }
  aliasMemoTree = node.tree;
  aliasMemo = aliases;
  return aliases;
}

/** The module a file declares (`module Token.Asset where`), or null without a header. */
export function fileModuleName(node: SyntaxNode, source: string): string | null {
  const header = rootOf(node).namedChildren.find((c) => c?.type === 'header');
  const mod = header ? getChildByField(header, 'module') : null;
  return mod ? moduleDottedName(mod, source) : null;
}

export interface QualifiedRef {
  /** `Module::name` — the first candidate when the qualifier is ambiguous. */
  referenceName: string;
  /** Every `Module::name` an alias shared by several imports can stand for. */
  candidates?: string[];
}

/**
 * `U.feeFor` → `Lib.Util::feeFor` for a `qualified` node, expanding an import
 * alias; null when the node isn't qualified. An alias several imports share
 * yields one candidate per module for the resolver to choose from.
 */
export function qualifiedRef(node: SyntaxNode, source: string): QualifiedRef | null {
  if (node.type !== 'qualified') return null;
  const mod = getChildByField(node, 'module');
  const id = getChildByField(node, 'id');
  if (!mod || !id) return null;
  const written = moduleDottedName(mod, source);
  const member = getNodeText(id, source);
  const modules = moduleAliases(node, source).get(written) ?? [written];
  const names = modules.map((m) => `${m}::${member}`);
  return names.length === 1 ? { referenceName: names[0]! } : { referenceName: names[0]!, candidates: names };
}

/** A declaration directly in the module body (not in a where/let/class/instance). */
export function isTopLevelDecl(node: SyntaxNode): boolean {
  const parent = node.parent;
  return parent?.type === 'declarations' && parent.parent?.parent === null;
}

/** Whether a top-level declaration named `name` is exported by its module. */
export function isExportedName(node: SyntaxNode, name: string, source: string): boolean {
  if (!isTopLevelDecl(node)) return false;
  const exports = moduleExports(node, source);
  return exports.names === null || exports.names.has(name);
}

/** Whether a constructor or field of exported type `typeName` is exported. */
function isExportedChild(typeNode: SyntaxNode, typeName: string, childName: string, source: string): boolean {
  if (!isTopLevelDecl(typeNode)) return false;
  const exports = moduleExports(typeNode, source);
  return exports.names === null || exports.allChildren.has(typeName) || exports.names.has(childName);
}

// --- Per-file memos. Extraction is file-sequential within a worker, so a
// single-entry memo keyed by filePath is safe (and resets naturally). ---

/** Clause-merge state: consecutive same-name function/bind nodes *in the same
 * enclosing scope* merge into one. The scope key is the top of the node stack
 * (the instance/class/top-level container) so two `instance` blocks each
 * defining `show` don't collapse into one node. */
// Keyed by the parse tree: re-extracting the same path (a sync, a re-index)
// must not continue the previous extraction's last function.
let lastFnTree: unknown = null;
let lastFnName = '';
let lastFnScope = '';
let lastFnId = '';

function resetFnMemo(node: SyntaxNode): void {
  if (lastFnTree !== node.tree) {
    lastFnTree = node.tree;
    lastFnName = '';
    lastFnScope = '';
    lastFnId = '';
  }
}

/** Walk a `match` node's expression subtree (and where-clause locals) for calls. */
function visitMatch(matchNode: SyntaxNode, fnId: string, ctx: ExtractorContext): void {
  ctx.pushScope(fnId);
  // The match node itself holds the expression (field `expression`) and
  // optional guards. Walk all named children so guards, the body expression,
  // and any local-binds are all covered.
  for (let i = 0; i < matchNode.namedChildCount; i++) {
    const child = matchNode.namedChild(i);
    if (child) ctx.visitNode(child);
  }
  ctx.popScope();
}

/**
 * Handle a `function` or `bind` node (both are function definitions). `kind`
 * lets a dialect record implementation bodies as methods.
 */
export function handleFunctionLike(node: SyntaxNode, ctx: ExtractorContext, kind: NodeKind = 'function'): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source);
  if (!name) return true;

  resetFnMemo(node);

  // Continuation clause: same-name consecutive function *in the same enclosing
  // scope* — extend the existing node and attribute this clause's calls to it.
  // The scope key (top of nodeStack) distinguishes methods of different
  // type-class instances that happen to share a name (e.g. two `show` impls).
  const currentScope = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  if (name === lastFnName && lastFnId && currentScope === lastFnScope) {
    for (let i = ctx.nodes.length - 1; i >= 0; i--) {
      const n = ctx.nodes[i];
      if (n && n.id === lastFnId) {
        if (node.endPosition.row + 1 > n.endLine) n.endLine = node.endPosition.row + 1;
        break;
      }
    }
    const match = getChildByField(node, 'match');
    if (match) visitMatch(match, lastFnId, ctx);
    // where-clause local binds (sibling `binds` field on the function node)
    const binds = getChildByField(node, 'binds');
    if (binds) {
      ctx.pushScope(lastFnId);
      for (let i = 0; i < binds.namedChildCount; i++) {
        const child = binds.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      ctx.popScope();
    }
    return true;
  }

  const sig = precedingSignature(node, name, ctx.source);
  const doc = precedingHaddock(sig ?? node, ctx.source);
  const fn = ctx.createNode(kind, name, node, {
    docstring: doc,
    signature: sig ? collapseWs(getNodeText(sig, ctx.source)).slice(0, 300) : undefined,
    isExported: isExportedName(node, name, ctx.source),
  });
  if (!fn) return true;
  lastFnName = name;
  lastFnScope = currentScope;
  lastFnId = fn.id;

  const match = getChildByField(node, 'match');
  if (match) visitMatch(match, fn.id, ctx);
  // where-clause local binds
  const binds = getChildByField(node, 'binds');
  if (binds) {
    ctx.pushScope(fn.id);
    for (let i = 0; i < binds.namedChildCount; i++) {
      const child = binds.namedChild(i);
      if (child) ctx.visitNode(child);
    }
    ctx.popScope();
  }
  return true;
}

/**
 * `bind` nodes that are not definitions:
 *
 * - a `do` statement or guard `pat <- e` (no `match`), whose expression runs in
 *   the enclosing function;
 * - a value binding in a `do` block's `let` (`let fee = computeFee amount`),
 *   which is part of the enclosing function's body rather than a callable of
 *   its own. Without this, calls in it hang off a nested node that nothing
 *   calls, and drop out of the function's call tree.
 *
 * Their calls are attributed to the current scope. `where` bindings stay
 * definitions: point-free local functions are common there.
 */
function handleStatementBind(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const match = getChildByField(node, 'match');
  if (!match) {
    const expression = getChildByField(node, 'expression');
    if (expression) ctx.visitNode(expression);
    return true;
  }
  const localBinds = node.parent;
  const isDoLetValue =
    localBinds?.type === 'local_binds' &&
    localBinds.parent?.type === 'let' &&
    localBinds.parent.parent?.type === 'do' &&
    !!getChildByField(node, 'name');
  if (!isDoLetValue) return false;
  for (const child of match.namedChildren) {
    if (child) ctx.visitNode(child);
  }
  const binds = getChildByField(node, 'binds');
  if (binds) {
    for (const child of binds.namedChildren) {
      if (child) ctx.visitNode(child);
    }
  }
  return true;
}

/** Handle a `data_type` node — struct + constructors (enum_members) + record fields. */
export function handleDataType(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const typeName = getNodeText(nameNode, ctx.source);
  const doc = precedingHaddock(node, ctx.source);
  const struct = ctx.createNode('struct', typeName, node, {
    docstring: doc,
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
    isExported: isExportedName(node, typeName, ctx.source),
  });
  if (!struct) return true;

  ctx.pushScope(struct.id);
  const ctors = getChildByField(node, 'constructors');
  if (ctors) {
    for (let i = 0; i < ctors.namedChildCount; i++) {
      const dc = ctors.namedChild(i);
      if (!dc || dc.type !== 'data_constructor') continue;
      // The constructor shape is under a `prefix`, `record`, or `infix` child
      // (field `constructor`).
      const shape = getChildByField(dc, 'constructor');
      if (!shape) continue;
      const ctorNameNode = getChildByField(shape, 'name') || getChildByField(shape, 'constructor');
      const ctorName = ctorNameNode ? getNodeText(ctorNameNode, ctx.source) : null;
      if (ctorName) {
        ctx.createNode('enum_member', ctorName, dc, {
          isExported: isExportedChild(node, typeName, ctorName, ctx.source),
        });
      }
      // Record fields
      if (shape.type === 'record') {
        const fields = getChildByField(shape, 'fields');
        if (fields) {
          for (let j = 0; j < fields.namedChildCount; j++) {
            const field = fields.namedChild(j);
            if (!field || field.type !== 'field') continue;
            const fNameNode = getChildByField(field, 'name');
            if (!fNameNode) continue;
            const fieldName = getNodeText(fNameNode, ctx.source);
            ctx.createNode('field', fieldName, field, {
              isExported: isExportedChild(node, typeName, fieldName, ctx.source),
            });
          }
        }
      }
    }
  }
  ctx.popScope();
  return true; // don't descend into type-position expressions
}

/** Handle a `newtype` node — struct + single constructor + field. */
export function handleNewtype(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const typeName = getNodeText(nameNode, ctx.source);
  const struct = ctx.createNode('struct', typeName, node, {
    docstring: precedingHaddock(node, ctx.source),
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
    isExported: isExportedName(node, typeName, ctx.source),
  });
  if (!struct) return true;

  ctx.pushScope(struct.id);
  const ctor = getChildByField(node, 'constructor');
  if (ctor) {
    const ctorNameNode = getChildByField(ctor, 'name') || getChildByField(ctor, 'constructor');
    if (ctorNameNode) ctx.createNode('enum_member', getNodeText(ctorNameNode, ctx.source), ctor);
    const field = getChildByField(ctor, 'field');
    if (field) {
      const fNameNode = getChildByField(field, 'name');
      if (fNameNode) ctx.createNode('field', getNodeText(fNameNode, ctx.source), field);
    }
  }
  ctx.popScope();
  return true;
}

/** Handle a `type_synomym` node (note: grammar typo is intentional) — type_alias. */
export function handleTypeSynonym(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source);
  ctx.createNode('type_alias', name, node, {
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
    isExported: isExportedName(node, name, ctx.source),
  });
  return true; // the type body is type-position — don't descend
}

/** Handle a `class` node — trait + default method implementations. */
export function handleClass(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source);
  const trait = ctx.createNode('trait', name, node, {
    docstring: precedingHaddock(node, ctx.source),
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
    isExported: isExportedName(node, name, ctx.source),
  });
  if (!trait) return true;

  ctx.pushScope(trait.id);
  const decls = getChildByField(node, 'declarations');
  if (decls) {
    const module = fileModuleName(node, ctx.source);
    for (let i = 0; i < decls.namedChildCount; i++) {
      const child = decls.namedChild(i);
      if (!child) continue;
      if (child.type === 'signature') handleClassMethodSignature(child, module, name, ctx);
      else ctx.visitNode(child);
    }
  }
  ctx.popScope();
  return true;
}

/**
 * A class method's signature declares a module-level function (`M.method`
 * calls it through any instance), so it is a method node qualified
 * `Module::method` — the form a qualified call resolves against.
 */
function handleClassMethodSignature(sig: SyntaxNode, module: string | null, className: string, ctx: ExtractorContext): void {
  const nameNodes = sig.childrenForFieldName('name').filter((n): n is SyntaxNode => !!n);
  const names = getChildByField(sig, 'names');
  if (names) nameNodes.push(...names.childrenForFieldName('name').filter((n): n is SyntaxNode => !!n));
  for (const nameNode of nameNodes) {
    const methodName = getNodeText(nameNode, ctx.source).replace(/^\((.*)\)$/, '$1');
    ctx.createNode('method', methodName, sig, {
      ...(module ? { qualifiedName: `${module}::${methodName}` } : {}),
      signature: collapseWs(getNodeText(sig, ctx.source)).slice(0, 300),
      docstring: precedingHaddock(sig, ctx.source),
      isAbstract: true,
      isExported: isExportedName(sig.parent?.parent ?? sig, className, ctx.source),
    });
  }
}

/** Handle an `instance` node — class node + implements reference + methods. */
export function handleInstance(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const className = getNodeText(nameNode, ctx.source);
  // Derive the instance type from `patterns: type_patterns`
  const typePatterns = getChildByField(node, 'patterns');
  let instanceType = '';
  if (typePatterns) {
    const firstChild = typePatterns.namedChild(0);
    if (firstChild) instanceType = getNodeText(firstChild, ctx.source);
  }
  const instanceName = instanceType ? `${className}.${instanceType}` : className;
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];

  const instNode = ctx.createNode('class', instanceName, node, {
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
  });

  // Emit an `implements` reference to the class so the resolver links it.
  if (parentId) {
    ctx.addUnresolvedReference({
      fromNodeId: instNode?.id ?? parentId,
      referenceName: className,
      referenceKind: 'implements',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  if (!instNode) return true;

  ctx.pushScope(instNode.id);
  const decls = getChildByField(node, 'declarations');
  if (decls) {
    for (let i = 0; i < decls.namedChildCount; i++) {
      const child = decls.namedChild(i);
      if (child) ctx.visitNode(child);
    }
  }
  ctx.popScope();
  return true;
}

export const haskellExtractor: LanguageExtractor = {
  functionTypes: [],  // dispatched via visitNode (name lives on a `variable` child of the `function`/`bind` node)
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],     // dispatched via visitNode
  enumTypes: [],
  typeAliasTypes: [],  // dispatched via visitNode
  importTypes: ['import'],
  callTypes: ['apply', 'infix'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'match',
  paramsField: 'patterns',
  interfaceKind: 'trait',

  // `header` wraps `module: module` → wraps the file's declarations in a
  // namespace so qualified calls (`Data.Map.fromList`) resolve via
  // matchByQualifiedName — mirrors Erlang's -module(m).
  packageTypes: ['header'],
  extractPackage: (node, source) => {
    const mod = getChildByField(node, 'module');
    if (!mod) return null;
    return moduleDottedName(mod, source);
  },

  extractImport: (node, source) => {
    const modNode = getChildByField(node, 'module');
    if (!modNode) return null;
    const moduleName = moduleDottedName(modNode, source);
    if (!moduleName) return null;
    return {
      moduleName,
      signature: collapseWs(getNodeText(node, source)).slice(0, 200),
    };
  },

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'bind':
        return handleStatementBind(node, ctx) || handleFunctionLike(node, ctx);
      case 'function':
        return handleFunctionLike(node, ctx);
      case 'signature':
        return true; // metadata for the following function — skip as a node
      case 'data_type':
        return handleDataType(node, ctx);
      case 'newtype':
        return handleNewtype(node, ctx);
      case 'type_synomym':
        return handleTypeSynonym(node, ctx);
      case 'class':
        return handleClass(node, ctx);
      case 'instance':
        return handleInstance(node, ctx);
      case 'haddock':
      case 'comment':
        return true;
      default:
        return false;
    }
  },
};