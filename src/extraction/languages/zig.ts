import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * Zig extraction.
 *
 * Zig has no classes and no top-level named type declarations: a type is a
 * VALUE produced by a container expression (`struct`/`enum`/`union`/`opaque`)
 * and bound to a `const`, and a module is a `const` bound to `@import(...)`.
 * So one grammar node — `variable_declaration` — fans out to several CodeGraph
 * kinds depending on its right-hand side:
 *
 *   const Point  = struct { ... };   // → struct
 *   const Color  = enum { ... };     // → enum
 *   const Token  = union { ... };     // → struct  (no `union` NodeKind)
 *   const std    = @import("std");   // → import + `imports` ref
 *   const max    = 8;                // → constant
 *   var   count: usize = 0;          // → variable
 *
 * The node-type dispatch ladder in tree-sitter.ts keys on a single node type,
 * so this fan-out is done in the `visitNode` hook (the documented escape hatch
 * for languages whose AST shape doesn't fit the ladder — Pascal uses it too).
 * Everything UNAMBIGUOUS is left to the ladder: `function_declaration` (a free
 * function at file scope, a method when nested in a container scope the hook
 * pushed), and `call_expression`. Methods are detected purely by scope —
 * `isInsideClassLikeNode()` — because Zig has no receiver syntax; the `self`
 * parameter is an ordinary parameter, so `getReceiverType` is deliberately unset.
 *
 * Container members live as DIRECT children of the container node (there is no
 * `body` field), so `extractStruct`/`extractEnum` — which require one — can't be
 * reused; the hook walks members itself and routes each back through
 * `ctx.visitNode`, so methods/nested types/calls still flow through the core.
 */

/** Container-expression node types whose members are walked as a scope. */
const CONTAINER_KINDS = new Set([
  'struct_declaration',
  'union_declaration',
  'opaque_declaration',
  'enum_declaration',
]);

/** `@import`/`@embedFile`/`@cImport` builtins that introduce a module dependency. */
const IMPORT_BUILTINS = new Set(['@import', '@embedFile', '@cImport']);

/** Scope kinds under which a `const`/`var` is a real symbol, not a function local. */
const CONTAINER_SCOPE_KINDS = new Set([
  'file', 'module', 'namespace', 'struct', 'enum', 'class', 'interface', 'trait',
]);

/** Whether a node has the `pub` visibility modifier as a direct child token. */
function hasPub(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'pub') return true;
  }
  return false;
}

/** `const` vs `var` — read the leading keyword token; default to const. */
function isConstDecl(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const t = node.child(i)?.type;
    if (t === 'const') return true;
    if (t === 'var') return false;
  }
  return true;
}

/** The bound name of a `variable_declaration` — its first `identifier` child
 *  (the type annotation's identifiers are nested under the `type` field). */
function declName(node: SyntaxNode, source: string): string | null {
  const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  return id ? getNodeText(id, source) : null;
}

/** The right-hand side of a `variable_declaration`: the first named child that
 *  begins after the `=` token. Returns null for a bare `var x: T;` (no value). */
function rhsValue(node: SyntaxNode): SyntaxNode | null {
  let eqEnd = -1;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === '=') { eqEnd = c.endIndex; break; }
  }
  if (eqEnd < 0) return null;
  return node.namedChildren.find((c: SyntaxNode) => c.startIndex >= eqEnd) ?? null;
}

/** The imported module/file for an `@import`-family builtin, or null. The string
 *  argument is returned verbatim ("std", "builtin", "./foo.zig"); a `@cImport`
 *  with no string argument resolves to the conventional "c" module. */
function importTarget(builtin: SyntaxNode, source: string): string | null {
  const id = builtin.namedChildren.find((c: SyntaxNode) => c.type === 'builtin_identifier');
  if (!id) return null;
  const name = getNodeText(id, source);
  if (!IMPORT_BUILTINS.has(name)) return null;
  const args = builtin.namedChildren.find((c: SyntaxNode) => c.type === 'arguments');
  const str = args?.namedChildren.find((c: SyntaxNode) => c.type === 'string');
  if (!str) return name === '@cImport' ? 'c' : null;
  return getNodeText(str, source).replace(/^"/, '').replace(/"$/, '');
}

/** The CodeGraph kind of the innermost scope on the stack ('file' when empty). */
function scopeKind(ctx: ExtractorContext): string {
  if (ctx.nodeStack.length === 0) return 'file';
  const top = ctx.nodeStack[ctx.nodeStack.length - 1];
  return ctx.nodes.find((n) => n.id === top)?.kind ?? 'file';
}

/**
 * Create the type node for a container-valued declaration and walk its members
 * under that scope, so nested `function_declaration`s become methods (via the
 * core ladder's `isInsideClassLikeNode()` check) and nested types recurse here.
 * An `enum`'s `container_field`s are its members (→ `enum_member`); a struct's
 * are fields (→ `field`).
 */
function extractContainer(
  decl: SyntaxNode,
  value: SyntaxNode,
  name: string,
  ctx: ExtractorContext,
): void {
  const isEnum = value.type === 'enum_declaration';
  const owner = ctx.createNode(isEnum ? 'enum' : 'struct', name, decl, {
    docstring: getPrecedingDocstring(decl, ctx.source),
    visibility: hasPub(decl) ? 'public' : 'private',
    isExported: hasPub(decl),
  });
  if (!owner) return;

  ctx.pushScope(owner.id);
  for (const child of value.namedChildren) {
    if (child.type === 'container_field') {
      const nameNode = getChildByField(child, 'name') ?? child;
      const member = getNodeText(nameNode, ctx.source);
      if (isEnum) {
        ctx.createNode('enum_member', member, child);
      } else {
        const typeNode = getChildByField(child, 'type');
        ctx.createNode('field', member, child, {
          signature: typeNode ? `: ${getNodeText(typeNode, ctx.source)}` : undefined,
        });
      }
    } else {
      // function_declaration → method, nested variable_declaration → back here,
      // test_declaration → test, comptime_declaration → descend for calls.
      ctx.visitNode(child);
    }
  }
  ctx.popScope();
}

/** An `error { A, B }` set bound to a const → an enum whose members are the
 *  error names, so `MyError.A` navigation and impact analysis resolve. */
function extractErrorSet(decl: SyntaxNode, value: SyntaxNode, name: string, ctx: ExtractorContext): void {
  const owner = ctx.createNode('enum', name, decl, {
    docstring: getPrecedingDocstring(decl, ctx.source),
    visibility: hasPub(decl) ? 'public' : 'private',
    isExported: hasPub(decl),
  });
  if (!owner) return;
  ctx.pushScope(owner.id);
  for (const child of value.namedChildren) {
    if (child.type === 'identifier') {
      ctx.createNode('enum_member', getNodeText(child, ctx.source), child);
    }
  }
  ctx.popScope();
}

/** `const m = @import("foo.zig")` → an `import` node plus an `imports` reference
 *  the resolver maps to the target file (internal) or leaves external (std). */
function extractImport(decl: SyntaxNode, value: SyntaxNode, ctx: ExtractorContext): boolean {
  const target = importTarget(value, ctx.source);
  if (!target) return false;
  ctx.createNode('import', target, decl, { signature: getNodeText(decl, ctx.source).trim() });
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (parentId) {
    ctx.addUnresolvedReference({
      fromNodeId: parentId,
      referenceName: target,
      referenceKind: 'imports',
      line: decl.startPosition.row + 1,
      column: decl.startPosition.column,
    });
  }
  return true;
}

/** Route a `variable_declaration` to the right extraction based on its RHS. */
function visitVarDecl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = declName(node, ctx.source);
  if (!name) return false;
  const value = rhsValue(node);

  if (value) {
    if (CONTAINER_KINDS.has(value.type)) {
      extractContainer(node, value, name, ctx);
      return true;
    }
    if (value.type === 'error_set_declaration') {
      extractErrorSet(node, value, name, ctx);
      return true;
    }
    if (value.type === 'builtin_function' && extractImport(node, value, ctx)) {
      return true;
    }
  }

  // A plain value is a symbol only at container scope; inside a function body it
  // is a local and must not become a node.
  if (!CONTAINER_SCOPE_KINDS.has(scopeKind(ctx))) return true;
  const valText = value ? getNodeText(value, ctx.source).slice(0, 80) : undefined;
  ctx.createNode(isConstDecl(node) ? 'constant' : 'variable', name, node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    signature: valText ? `= ${valText}${valText.length >= 80 ? '...' : ''}` : undefined,
    visibility: hasPub(node) ? 'public' : 'private',
    isExported: hasPub(node),
  });
  return true;
}

/** `test "name" { ... }` (or unnamed `test { ... }`) → a `function` node whose
 *  body is walked, so a test shows up in `callers`/blast-radius of what it
 *  exercises — the thing CodeGraph is for when triaging a Zig change. */
function visitTest(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const str = node.namedChildren.find((c: SyntaxNode) => c.type === 'string' || c.type === 'identifier');
  const name = str ? getNodeText(str, ctx.source).replace(/^"/, '').replace(/"$/, '') : 'test';
  const fn = ctx.createNode('function', name, node, { signature: 'test' });
  const body = node.namedChildren.find((c: SyntaxNode) => c.type === 'block');
  if (fn && body) {
    ctx.pushScope(fn.id);
    ctx.visitFunctionBody(body, fn.id);
    ctx.popScope();
  }
  return true;
}

/** A type factory `fn Name(...) type { return struct {...}; }` — return the
 *  container the function produces, or null if it isn't one. Only a direct
 *  `return` statement is considered; nested scopes (the container's own methods)
 *  are not searched. A returned `struct {...}` is a type DEFINITION
 *  (struct_declaration); a returned `.{...}` value is not, so plain functions
 *  are never mistaken for factories. */
function returnedContainer(fnNode: SyntaxNode): SyntaxNode | null {
  const body = getChildByField(fnNode, 'body');
  if (!body) return null;
  for (const stmt of body.namedChildren) {
    const ret = stmt.type === 'return_expression'
      ? stmt
      : stmt.namedChildren.find((c: SyntaxNode) => c.type === 'return_expression');
    const val = ret?.namedChildren[0];
    if (val && CONTAINER_KINDS.has(val.type)) return val;
  }
  return null;
}

/** Zig generic types ARE functions returning an anonymous container
 *  (`fn List(comptime T: type) type { return struct {...}; }` — the ArrayList
 *  idiom). Index such a factory as the type it yields: a struct/enum named for
 *  the function, with the container's declarations as methods, so `List.append`
 *  navigates like any other type. A normal function returns false and falls
 *  through to the core ladder unchanged. */
function visitFnDecl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const container = returnedContainer(node);
  if (!container) return false;
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return false;
  extractContainer(node, container, getNodeText(nameNode, ctx.source), ctx);
  return true;
}

export const zigExtractor: LanguageExtractor = {
  // function_declaration is BOTH the free-function and the method node type;
  // the ladder picks method when it fires inside a pushed container scope.
  functionTypes: ['function_declaration'],
  classTypes: [],
  methodTypes: ['function_declaration'],
  interfaceTypes: [],
  // Containers, imports, constants and fields are all reached through
  // variable_declaration and handled in visitNode — so these stay empty.
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  variableTypes: [],
  callTypes: ['call_expression'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type', // Zig: a function's return type is the `type` field.

  getSignature: (node, source) => {
    const params = node.namedChildren.find((c: SyntaxNode) => c.type === 'parameters');
    const ret = getChildByField(node, 'type');
    if (!params && !ret) return undefined;
    let sig = params ? getNodeText(params, source) : '()';
    if (ret) sig += ` ${getNodeText(ret, source)}`;
    return sig;
  },

  // `pub` is Zig's only visibility marker (visible to importers); everything
  // else is file-private. `export`/`extern` are linkage, not source visibility.
  getVisibility: (node) => (hasPub(node) ? 'public' : 'private'),
  isExported: (node) => hasPub(node),

  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    if (node.type === 'variable_declaration') return visitVarDecl(node, ctx);
    if (node.type === 'function_declaration') return visitFnDecl(node, ctx);
    if (node.type === 'test_declaration') return visitTest(node, ctx);
    return false;
  },

};
