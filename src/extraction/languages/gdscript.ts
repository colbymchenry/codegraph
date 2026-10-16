import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

// Node names follow PrestonKnopp/tree-sitter-gdscript (ABI-15).
// GDScript is Python-like: indentation-based, dynamically typed, with
// Godot-specific constructs (class_name, extends, preload, signals, @export).

/** First descendant of a given type (breadth-first), or null. */
function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  const queue: SyntaxNode[] = [...node.namedChildren];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.type === type) return n;
    queue.push(...n.namedChildren);
  }
  return null;
}

/** Extract string content from a string literal node, stripping quotes. */
function extractString(node: SyntaxNode, source: string): string | null {
  const content = findDescendant(node, 'string_content');
  if (content) return getNodeText(content, source).trim() || null;
  const text = getNodeText(node, source).trim();
  return text.replace(/^["']|["']$/g, '') || null;
}

/**
 * Names of signals declared in this source (`signal NAME` at the start of a
 * line; annotations sit on their own lines). Engine signals (`pressed`,
 * `finished`, …) are declared nowhere in the file and stay out of the graph.
 * A cheap textual pre-scan: the extractor has no per-file init hook and the
 * AST walk is not guaranteed to reach a declaration before its uses.
 */
function declaredSignalNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/^[ \t]*signal[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    const name = m[1];
    if (name) names.add(name);
  }
  return names;
}

/** The callee of a GDScript `call` node — the grammar carries no `name` field. */
function calleeName(node: SyntaxNode, source: string): string {
  const callee = node.namedChildren.find((c) => c.type === 'identifier');
  return callee ? getNodeText(callee, source) : '';
}

/** First string-literal argument of a call node, unquoted. */
function firstStringArgument(node: SyntaxNode, source: string): string | null {
  const args = getChildByField(node, 'arguments');
  const str = args ? findDescendant(args, 'string') : null;
  return str ? extractString(str, source) : null;
}

/** Reference from the enclosing scope (file or function) to a declared signal. */
function addSignalReference(ctx: ExtractorContext, node: SyntaxNode, signalName: string): void {
  const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] : undefined;
  if (!parentId) return;
  ctx.addUnresolvedReference({
    fromNodeId: parentId,
    referenceName: signalName,
    referenceKind: 'references',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/**
 * `preload("res://…")` / `load("res://…")` → an import node plus an import
 * reference from the enclosing scope, so the target file shows up as a
 * dependent in impact queries.
 */
function claimImport(node: SyntaxNode, ctx: ExtractorContext): void {
  const path = firstStringArgument(node, ctx.source);
  if (!path) return;
  const imp = ctx.createNode('import', path, node, {
    signature: getNodeText(node, ctx.source).trim().slice(0, 100),
  });
  const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] : undefined;
  if (imp && parentId) {
    ctx.addUnresolvedReference({
      fromNodeId: parentId,
      referenceName: path,
      referenceKind: 'imports',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }
}

/** The last identifier of an attribute chain (`a.b.c` → `c`); a bare
 * identifier names itself. */
function lastChainName(node: SyntaxNode, source: string): string {
  if (node.type === 'identifier') return getNodeText(node, source);
  const last = node.namedChildren[node.namedChildren.length - 1];
  return last ? lastChainName(last, source) : '';
}

/**
 * `some_signal.emit(...)` / `some_signal.connect(...)` — the grammar parses
 * these as `attribute` (… + attribute_call), which the generic call walker
 * ignores entirely. A chain (`node.data_loaded.connect(…)`, Godot's
 * everyday cross-file subscription) names the signal by its last segment;
 * a bare `self` signal is filed only when declared in the file, so engine
 * signals (`pressed`, `finished`, …) add no edges.
 */
function claimAttributeSignalReference(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const kids = node.namedChildren;
  if (kids.length < 2) return false;
  const call = kids[kids.length - 1];
  if (!call || call.type !== 'attribute_call') return false;
  const methodNode = call.namedChildren.find((c) => c.type === 'identifier');
  const method = methodNode ? getNodeText(methodNode, ctx.source) : '';
  if (method !== 'emit' && method !== 'connect') return false;
  const obj = kids[kids.length - 2];
  if (!obj) return false;
  const signalName = lastChainName(obj, ctx.source);
  if (!signalName) return false;
  if (kids.length === 2 && obj.type === 'identifier' && !declaredSignalNames(ctx.source).has(signalName)) {
    return false;
  }
  addSignalReference(ctx, node, signalName);
  return true;
}

/**
 * `emit_signal("name", …)` / `connect("name", …)` — the string forms; the
 * receiver is the implicit `self`. Claimed either way so the generic walker
 * doesn't file a `calls emit_signal` reference that resolves to nothing.
 */
function claimStringSignalReference(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const signalName = firstStringArgument(node, ctx.source);
  if (signalName && declaredSignalNames(ctx.source).has(signalName)) {
    addSignalReference(ctx, node, signalName);
  }
  return true;
}

/**
 * Extract the base name from an extends_statement.
 * Returns null if no extends clause found.
 */
function extractExtends(node: SyntaxNode, source: string): string | null {
  // Look for extends_statement child (used by class_name_statement)
  const extendsStmt = node.namedChildren.find((c) => c.type === 'extends_statement');
  if (!extendsStmt) return null;

  // extends_statement > type > identifier or string
  const typeNode = getChildByField(extendsStmt, 'type');
  if (!typeNode) return null;

  const ident = typeNode.namedChildren.find((c) => c.type === 'identifier');
  if (ident) return getNodeText(ident, source);

  const str = typeNode.namedChildren.find((c) => c.type === 'string');
  if (str) return extractString(str, source);
  return null;
}

/**
 * A node-path reference from inside a script (`$Foo/Bar`,
 * `%Unique`, `get_node("…")`) — resolved onto the scene node the path names
 * (GDScript and Godot resources share a language family for exactly this).
 */
function addNodePathReference(ctx: ExtractorContext, node: SyntaxNode, path: string): void {
  const normalized = path.replace(/^\.?\/*/, '');
  if (!normalized) return;
  const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] : undefined;
  if (!parentId) return;
  ctx.addUnresolvedReference({
    fromNodeId: parentId,
    referenceName: normalized,
    referenceKind: 'references',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** `$Foo/Bar` / `%Unique` — the grammar's dedicated `get_node` node. Its path
 * segments are anonymous tokens (no named children), so take the node text:
 * `$Name`, `$/Root/Name`, `$%Unique`, `%Name`, quoted segments included. */
function claimShorthandNodePath(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const path = getNodeText(node, ctx.source)
    .trim()
    .replace(/^[%$]+/, '')
    .replace(/"([^"]*)"/g, '$1');
  if (!path) return false;
  addNodePathReference(ctx, node, path);
  return true;
}

/** preload/load, emit_signal/connect and signal attributes — shared by both walkers. */
function claimGdscriptCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const callee = calleeName(node, ctx.source);
  if (callee === 'preload' || callee === 'load') {
    claimImport(node, ctx);
    return true;
  }
  if (callee === 'emit_signal' || callee === 'connect') {
    return claimStringSignalReference(node, ctx);
  }
  if (callee === 'get_node' || callee === 'get_node_or_null' || callee === 'has_node') {
    const path = firstStringArgument(node, ctx.source);
    if (path) addNodePathReference(ctx, node, path);
    return true; // claimed either way: no bare `get_node` call ref
  }
  return false;
}

export const gdscriptExtractor: LanguageExtractor = {
  // GDScript functions: `func name(...)` — top-level or inside class.
  // class_name_statement creates global classes (no class keyword needed).
  functionTypes: ['function_definition'],
  classTypes: ['class_name_statement'],
  methodTypes: [], // methods are function_definition inside class context
  interfaceTypes: [],
  structTypes: [],
  // enum blocks: `enum { A, B }` or `enum Name { A, B }`
  enumTypes: ['enum_definition'],
  typeAliasTypes: [],
  importTypes: [], // preload/load are function calls — handled in visitNode
  callTypes: ['call'],
  variableTypes: [], // GDScript vars are not first-class symbols in most cases
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node: SyntaxNode, source: string) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },

  // For function_definition inside a class, the class name is the receiver.
  // This is handled by the extraction framework via nodeStack context.
  getReceiverType: () => undefined,

  // Handle signal declarations, preload/load call sites and extends clauses.
  visitNode: (node: SyntaxNode, ctx) => {
    const source = ctx.source;

    // Signal declarations: `signal name(params)`. Indexed as a field so
    // emitters and subscribers have a findable declaration (the same choice
    // VB.NET events made).
    if (node.type === 'signal_statement') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const params = getChildByField(node, 'parameters');
        ctx.createNode('field', getNodeText(nameNode, source), node, {
          signature: params ? getNodeText(params, source) : undefined,
        });
      }
      return true;
    }

    // `$Foo/Bar` / `%Unique` — the grammar parses the shorthand as a dedicated
    // `get_node` node; file the scene-node reference it names.
    if (node.type === 'get_node') {
      return claimShorthandNodePath(node, ctx);
    }

    // preload/load at script top level (`const X = preload("res://…")`).
    if (node.type === 'call') {
      return claimGdscriptCall(node, ctx);
    }

    // Handle extends clauses on class_name_statement.
    if (node.type === 'class_name_statement') {
      const base = extractExtends(node, source);
      if (base && ctx.nodeStack.length > 0) {
        const classId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (classId) {
          ctx.addUnresolvedReference({
            fromNodeId: classId,
            referenceName: base,
            referenceKind: 'extends',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      return false;
    }

    return false;
  },

  // Function bodies are walked by a separate walker that never reaches
  // visitNode — signal emit/connect and preload call sites inside functions
  // are claimed here.
  visitBodyNode: (node: SyntaxNode, ctx) => {
    if (node.type === 'call') {
      return claimGdscriptCall(node, ctx);
    }
    if (node.type === 'get_node') {
      return claimShorthandNodePath(node, ctx);
    }
    if (node.type === 'attribute') {
      return claimAttributeSignalReference(node, ctx);
    }
    return false;
  },
};
