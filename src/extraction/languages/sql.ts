import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

// Plain SQL (`.sql`) via DerekStride/tree-sitter-sql v0.3.11 — vendored wasm,
// provenance in grammars.ts. Scope is deliberately narrow:
//
//   CREATE TABLE                       → struct   (+ `references` to FK targets)
//   CREATE [MATERIALIZED] VIEW         → struct   (+ `references` to FROM/JOIN tables)
//   CREATE FUNCTION                    → function (+ `references` / `calls` from its body)
//   top-level SELECT/INSERT/UPDATE/DELETE → `references` / `calls` from the file
//
// Not covered, because the grammar does not parse them (they come out as ERROR
// trees, so nothing is invented for them): CREATE PROCEDURE, procedural bodies
// (`BEGIN … END` in plpgsql / T-SQL), and templated SQL (dbt/Jinja).
//
// Tables and views are `struct`, never `class`: SQL objects share names with
// code symbols (`users`, `orders`), and the resolver keeps SQL in a language
// family of its own (CODE_FAMILY in name-matcher.ts) so they never link to code.

/** Last segment of an `object_reference` (`schema.name` → `name`), unquoted. */
function objectName(ref: SyntaxNode, source: string): string | undefined {
  const name = ref.childForFieldName('name');
  if (!name) return undefined;
  const text = getNodeText(name, source).trim().replace(/^(["`])(.*)\1$/, '$2');
  return text || undefined;
}

/** The first `object_reference` child of a node. */
function objectReferenceChild(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find((c): c is SyntaxNode => c?.type === 'object_reference');
}

/** True when `name` is a CTE (`WITH name AS (…)`) visible from `node`, not a table. */
function isCteName(node: SyntaxNode, name: string, source: string): boolean {
  const want = name.toLowerCase();
  for (let up: SyntaxNode | null = node.parent; up; up = up.parent) {
    for (const child of up.namedChildren) {
      if (child?.type !== 'cte') continue;
      const id = child.namedChildren.find((c) => c?.type === 'identifier');
      if (id && getNodeText(id, source).toLowerCase() === want) return true;
    }
  }
  return false;
}

function addRef(
  ctx: ExtractorContext,
  ref: SyntaxNode,
  kind: 'references' | 'calls',
  checkCte: boolean,
): void {
  const name = objectName(ref, ctx.source);
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!name || !fromNodeId) return;
  if (checkCte && isCteName(ref, name, ctx.source)) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: ref.startPosition.row + 1,
    column: ref.startPosition.column,
  });
}

/** `CREATE …` header up to the body, collapsed to one line (schema stays visible here). */
function headerSignature(node: SyntaxNode, source: string): string {
  const text = getNodeText(node, source);
  const cut = text.search(/\s+AS\b|\s*\(\s*$|\(/i);
  const head = (cut > 0 ? text.slice(0, cut) : text).replace(/\s+/g, ' ').trim();
  return head.length > 120 ? `${head.slice(0, 117)}…` : head;
}

const DEFINITIONS: Record<string, 'struct' | 'function'> = {
  create_table: 'struct',
  create_view: 'struct',
  create_materialized_view: 'struct',
  create_function: 'function',
};

export const sqlExtractor: LanguageExtractor = {
  // Everything goes through visitNode: SQL declarations name themselves with a
  // nested `object_reference`, not a `name` field the generic path can read.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    const kind = DEFINITIONS[node.type];
    if (kind) {
      const ref = objectReferenceChild(node);
      const name = ref && objectName(ref, ctx.source);
      if (!name) return false;
      const created = ctx.createNode(kind, name, node, {
        signature: headerSignature(node, ctx.source),
      });
      if (!created) return true;
      // Walk the children inside the new scope so the references below are
      // attributed to this object, not to the file.
      ctx.pushScope(created.id);
      for (const child of node.namedChildren) {
        if (child && child !== ref) ctx.visitNode(child);
      }
      ctx.popScope();
      return true;
    }

    switch (node.type) {
      // A table a query reads or writes: FROM/JOIN/UPDATE (`relation`), a
      // DELETE's target (`from`), an INSERT's target (`insert`).
      case 'relation':
      case 'from':
      case 'insert': {
        const ref = objectReferenceChild(node);
        if (ref) addRef(ctx, ref, 'references', true);
        return false;
      }
      // `REFERENCES other_table (id)` inside a column definition.
      case 'column_definition': {
        const ref = objectReferenceChild(node);
        if (ref) addRef(ctx, ref, 'references', false);
        return false;
      }
      case 'invocation': {
        const ref = objectReferenceChild(node);
        if (ref) addRef(ctx, ref, 'calls', false);
        return false;
      }
    }
    return false;
  },
};
