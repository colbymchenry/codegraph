import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

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
function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Read the text of a `module` node as a dotted module name (`Data.List`). */
function moduleDottedName(node: SyntaxNode, source: string): string {
  const parts: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'module_id') {
      parts.push(getNodeText(child, source));
    }
  }
  return parts.join('.');
}

/** Extract a Haddock comment (`-- | ...` / `{- | ... -}`) preceding a node.
 *  Haddocks sit as siblings of the `declarations` container (not as siblings
 *  of the declaration itself), so climb out of `declarations` to find them. */
function precedingHaddock(node: SyntaxNode, source: string): string | undefined {
  // Climb out of `declarations` so we see top-level siblings (haddocks sit
  // alongside `declarations`, not inside it).
  let anchor: SyntaxNode = node;
  while (anchor.parent && anchor.parent.type === 'declarations') anchor = anchor.parent;
  let sibling = anchor.previousNamedSibling;
  while (sibling?.type === 'haddock' || sibling?.type === 'comment') {
    if (sibling.type === 'haddock') {
      const text = getNodeText(sibling, source)
        .replace(/^--\s*\|?\s*/, '')
        .replace(/^\{-\s*\|?\s*/, '')
        .replace(/-}$/, '')
        .trim();
      return text || undefined;
    }
    sibling = sibling.previousNamedSibling;
  }
  return undefined;
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

// --- Per-file memos. Extraction is file-sequential within a worker, so a
// single-entry memo keyed by filePath is safe (and resets naturally). ---

/** Clause-merge state: consecutive same-name function/bind nodes *in the same
 * enclosing scope* merge into one. The scope key is the top of the node stack
 * (the instance/class/top-level container) so two `instance` blocks each
 * defining `show` don't collapse into one node. */
let lastFnFile = '';
let lastFnName = '';
let lastFnScope = '';
let lastFnId = '';

function resetFnMemo(filePath: string): void {
  if (lastFnFile !== filePath) {
    lastFnFile = filePath;
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

/** Handle a `function` or `bind` node (both are function definitions). */
function handleFunctionLike(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source);
  if (!name) return true;

  resetFnMemo(ctx.filePath);

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
  const fn = ctx.createNode('function', name, node, {
    docstring: doc,
    signature: sig ? collapseWs(getNodeText(sig, ctx.source)).slice(0, 300) : undefined,
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

/** Handle a `data_type` node — struct + constructors (enum_members) + record fields. */
function handleDataType(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const doc = precedingHaddock(node, ctx.source);
  const struct = ctx.createNode('struct', getNodeText(nameNode, ctx.source), node, {
    docstring: doc,
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
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
        ctx.createNode('enum_member', ctorName, dc);
      }
      // Record fields
      if (shape.type === 'record') {
        const fields = getChildByField(shape, 'fields');
        if (fields) {
          for (let j = 0; j < fields.namedChildCount; j++) {
            const field = fields.namedChild(j);
            if (!field || field.type !== 'field') continue;
            const fNameNode = getChildByField(field, 'name');
            if (fNameNode) ctx.createNode('field', getNodeText(fNameNode, ctx.source), field);
          }
        }
      }
    }
  }
  ctx.popScope();
  return true; // don't descend into type-position expressions
}

/** Handle a `newtype` node — struct + single constructor + field. */
function handleNewtype(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const struct = ctx.createNode('struct', getNodeText(nameNode, ctx.source), node, {
    docstring: precedingHaddock(node, ctx.source),
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
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
function handleTypeSynonym(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  ctx.createNode('type_alias', getNodeText(nameNode, ctx.source), node, {
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
  });
  return true; // the type body is type-position — don't descend
}

/** Handle a `class` node — trait + default method implementations. */
function handleClass(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const trait = ctx.createNode('trait', getNodeText(nameNode, ctx.source), node, {
    docstring: precedingHaddock(node, ctx.source),
    signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 300),
  });
  if (!trait) return true;

  ctx.pushScope(trait.id);
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

/** Handle an `instance` node — class node + implements reference + methods. */
function handleInstance(node: SyntaxNode, ctx: ExtractorContext): boolean {
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
      case 'function':
      case 'bind':
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