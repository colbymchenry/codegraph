import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

// Grammar: DerekStride/tree-sitter-sql, vendored ABI-15 build (tree-sitter-wasms
// does not ship SQL) at src/extraction/wasm/tree-sitter-sql.wasm — see grammars.ts.
//
// A CREATE TABLE/VIEW/FUNCTION names its subject via a nested
// `object_reference > name: identifier` CHILD, never a `name` field on the
// statement node itself, so resolveName digs into it. `column_definitions` and
// `function_body` are likewise plain (unnamed) children, not fields, so
// resolveBody finds them by node type instead of by field name.

const NAMED_DDL = new Set(['create_table', 'create_view', 'create_function', 'create_procedure']);

/** The first `object_reference` child of a node, or undefined. */
function objectReferenceChild(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find((c): c is SyntaxNode => !!c && c.type === 'object_reference');
}

/** An `object_reference`'s own `name` field text, or undefined. */
function objectReferenceName(ref: SyntaxNode, source: string): string | undefined {
  const name = getChildByField(ref, 'name');
  return name ? getNodeText(name, source) : undefined;
}

/** Emit an unresolved `references` edge from the enclosing symbol to a table named by an `object_reference`. */
function referenceTable(ctx: ExtractorContext, ref: SyntaxNode): void {
  const name = objectReferenceName(ref, ctx.source);
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!name || !fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: 'references',
    line: ref.startPosition.row + 1,
    column: ref.startPosition.column,
  });
}

export const sqlExtractor: LanguageExtractor = {
  functionTypes: ['create_function', 'create_procedure'],
  classTypes: ['create_table', 'create_view'], // closest kind for a table/view
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['invocation'],
  variableTypes: [],
  fieldTypes: ['column_definition'], // columns inside a create_table body
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  resolveName: (node, source) => {
    if (!NAMED_DDL.has(node.type)) return undefined;
    const ref = objectReferenceChild(node);
    return ref ? objectReferenceName(ref, source) : undefined;
  },

  resolveBody: (node) => {
    if (node.type === 'create_table') {
      return node.namedChildren.find((c) => c?.type === 'column_definitions') ?? null;
    }
    if (node.type === 'create_function' || node.type === 'create_procedure') {
      return node.namedChildren.find((c) => c?.type === 'function_body') ?? null;
    }
    return null;
  },

  getSignature: (node, source) => {
    if (node.type !== 'create_function' && node.type !== 'create_procedure') return undefined;
    const args = node.namedChildren.find((c) => c?.type === 'function_arguments');
    return args ? getNodeText(args, source) : undefined;
  },

  // Tables a query reads: FROM/JOIN targets (`relation`), a bare DELETE's
  // target (`from` with a direct `object_reference`, no `relation` wrapper),
  // and an INSERT's target (a direct `object_reference` child of `insert`).
  // UPDATE's target is wrapped in `relation` like a SELECT's, so it needs no
  // separate case. Returns false throughout so the default walk still
  // descends (into nested SELECTs, function calls, etc).
  visitNode: (node, ctx) => {
    if (node.type === 'relation' || node.type === 'from' || node.type === 'insert') {
      const ref = objectReferenceChild(node);
      if (ref) referenceTable(ctx, ref);
    }
    return false;
  },
};
