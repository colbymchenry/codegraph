import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind } from '../../types';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/**
 * PostgreSQL extractor for gmr/tree-sitter-postgres.
 *
 * The generated PostgreSQL grammar intentionally has no field map, so this
 * extractor cannot use the generic `nameField` / `bodyField` dispatcher.  It
 * recognizes statement shapes explicitly and keeps SQL's own dotted names as
 * qualified names (`schema.object`).  Generic CodeGraph node kinds are reused;
 * the precise database-object kind is retained as a `postgres:*` decorator.
 *
 * String-literal routine bodies are opaque leaves in the PostgreSQL grammar.
 * Top-level SQL and SQL expressions are therefore indexed here, while nested
 * SQL/PL/pgSQL extraction requires an injected body grammar and is deliberately
 * left for a follow-up.
 */

interface SqlName {
  parts: string[];
  qualified: string;
  simple: string;
}

type ReferenceKind = 'references' | 'calls';

const NAME_SEGMENT_TYPES = new Set(['ColId', 'ColLabel', 'type_function_name']);

// Avoid filling unresolved_refs with ubiquitous PostgreSQL/SQL built-ins. A
// schema-qualified spelling is never filtered because it may be user-defined.
const BUILTIN_ROUTINES = new Set([
  'any',
  'array_length',
  'array_remove',
  'array_agg',
  'avg',
  'bool_or',
  'cast',
  'coalesce',
  'concat',
  'count',
  'current_date',
  'current_setting',
  'current_time',
  'current_timestamp',
  'date_part',
  'date_trunc',
  'encode',
  'extract',
  'first_value',
  'gen_random_uuid',
  'greatest',
  'json_agg',
  'json_build_array',
  'json_build_object',
  'jsonb_agg',
  'jsonb_array_elements_text',
  'jsonb_array_length',
  'jsonb_build_array',
  'jsonb_build_object',
  'jsonb_set',
  'jsonb_strip_nulls',
  'jsonb_typeof',
  'least',
  'length',
  'lower',
  'max',
  'min',
  'nextval',
  'now',
  'nullif',
  'position',
  'round',
  'row_number',
  'row_to_json',
  'set_config',
  'split_part',
  'substring',
  'sum',
  'to_char',
  'to_date',
  'to_json',
  'to_jsonb',
  'trim',
  'unnest',
  'upper',
]);

/** Per-extraction reference de-duplication. `ctx.nodes` is stable for a file. */
const emittedReferenceKeys = new WeakMap<readonly object[], Set<string>>();

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) result.push(child);
  }
  return result;
}

function directChild(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && types.includes(child.type)) return child;
  }
  return null;
}

function firstDescendant(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
  for (const child of children(node)) {
    if (types.includes(child.type)) return child;
    const nested = firstDescendant(child, ...types);
    if (nested) return nested;
  }
  return null;
}

function allDescendants(node: SyntaxNode, type: string): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const visit = (current: SyntaxNode): void => {
    for (const child of children(current)) {
      if (child.type === type) result.push(child);
      visit(child);
    }
  };
  visit(node);
  return result;
}

function hasDirectChild(node: SyntaxNode, type: string): boolean {
  return directChild(node, type) !== null;
}

/** PostgreSQL folds unquoted identifiers to lower case; quoted names do not. */
function canonicalSegment(node: SyntaxNode, source: string): string {
  const raw = getNodeText(node, source).trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw.toLowerCase();
}

/**
 * Read a grammar name wrapper (`qualified_name`, `func_name`, `any_name`,
 * `name`, ...). Segment wrappers are used rather than identifier leaves so
 * keyword-shaped legal identifiers (for example `source`) are retained.
 */
function readSqlName(node: SyntaxNode | null, source: string): SqlName | null {
  if (!node) return null;
  const parts: string[] = [];

  const visit = (current: SyntaxNode): void => {
    if (NAME_SEGMENT_TYPES.has(current.type)) {
      const part = canonicalSegment(current, source);
      if (part) parts.push(part);
      return;
    }
    if (current.type === 'identifier' || current.type === 'quoted_identifier') {
      const part = canonicalSegment(current, source);
      if (part) parts.push(part);
      return;
    }
    for (const child of children(current)) visit(child);
  };

  visit(node);
  if (parts.length === 0) return null;
  return {
    parts,
    qualified: parts.join('.'),
    simple: parts[parts.length - 1]!,
  };
}

function nestedSchema(node: SyntaxNode, source: string): string | null {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'CreateSchemaStmt') {
      const nameNode = directChild(parent, 'ColId', 'opt_single_name');
      return readSqlName(nameNode, source)?.qualified ?? null;
    }
    parent = parent.parent;
  }
  return null;
}

function objectName(node: SyntaxNode, nameNode: SyntaxNode | null, source: string): SqlName | null {
  const name = readSqlName(nameNode, source);
  if (!name || name.parts.length > 1 || node.type === 'CreateSchemaStmt') return name;
  const schema = nestedSchema(node, source);
  if (!schema) return name;
  return {
    parts: [schema, ...name.parts],
    qualified: `${schema}.${name.qualified}`,
    simple: name.simple,
  };
}

function compactText(node: SyntaxNode, source: string, maxLength = 320): string {
  const compact = getNodeText(node, source).replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function currentScopeId(ctx: ExtractorContext): string | null {
  return ctx.nodeStack[ctx.nodeStack.length - 1] ?? null;
}

function currentScopeNode(ctx: ExtractorContext): Node | null {
  const id = currentScopeId(ctx);
  return id ? ctx.nodes.find((node) => node.id === id) ?? null : null;
}

function currentScopeQualifiedName(ctx: ExtractorContext): string | null {
  return currentScopeNode(ctx)?.qualifiedName ?? null;
}

function addReference(
  ctx: ExtractorContext,
  fromNodeId: string,
  target: SqlName,
  kind: ReferenceKind,
  positionNode: SyntaxNode
): void {
  let keys = emittedReferenceKeys.get(ctx.nodes);
  if (!keys) {
    keys = new Set<string>();
    emittedReferenceKeys.set(ctx.nodes, keys);
  }
  const key = `${fromNodeId}\u0000${kind}\u0000${target.qualified}`;
  if (keys.has(key)) return;
  keys.add(key);

  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: target.qualified,
    referenceKind: kind,
    line: positionNode.startPosition.row + 1,
    column: positionNode.startPosition.column,
  });
}

function createDatabaseNode(
  ctx: ExtractorContext,
  node: SyntaxNode,
  name: SqlName,
  kind: NodeKind,
  objectKind: string,
  qualifiedName = name.qualified,
  signature = compactText(node, ctx.source)
) {
  return ctx.createNode(kind, name.simple, node, {
    qualifiedName,
    signature,
    decorators: [`postgres:${objectKind}`],
    isExported: true,
  });
}

function walkChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of children(node)) ctx.visitNode(child);
}

function createColumn(ctx: ExtractorContext, node: SyntaxNode, nameNode: SyntaxNode): void {
  const name = readSqlName(nameNode, ctx.source);
  if (!name) return;
  const parentQualified = currentScopeQualifiedName(ctx);
  ctx.createNode('field', name.simple, node, {
    qualifiedName: parentQualified ? `${parentQualified}.${name.simple}` : name.qualified,
    signature: compactText(node, ctx.source, 200),
    decorators: ['postgres:column'],
    isExported: true,
  });
}

function createExplicitColumns(container: SyntaxNode | null, ctx: ExtractorContext): void {
  if (!container) return;
  const columnList = directChild(container, 'opt_column_list', 'columnList');
  if (!columnList) return;
  for (const column of allDescendants(columnList, 'columnElem')) {
    const nameNode = directChild(column, 'ColId');
    if (nameNode) createColumn(ctx, column, nameNode);
  }
}

function createEnumMembers(node: SyntaxNode, ctx: ExtractorContext): void {
  const values = directChild(node, 'opt_enum_val_list');
  if (!values) return;
  const parentQualified = currentScopeQualifiedName(ctx);
  for (const literal of allDescendants(values, 'string_literal')) {
    const raw = getNodeText(literal, ctx.source);
    const value = raw.startsWith("'") && raw.endsWith("'")
      ? raw.slice(1, -1).replace(/''/g, "'")
      : raw;
    if (!value) continue;
    ctx.createNode('enum_member', value, literal, {
      qualifiedName: parentQualified ? `${parentQualified}.${value}` : value,
      signature: raw,
      decorators: ['postgres:enum-value'],
      isExported: true,
    });
  }
}

function withCreatedScope(
  ctx: ExtractorContext,
  created: ReturnType<ExtractorContext['createNode']>,
  body: () => void
): void {
  if (!created) return;
  ctx.pushScope(created.id);
  try {
    body();
  } finally {
    ctx.popScope();
  }
}

function createTableLike(
  node: SyntaxNode,
  ctx: ExtractorContext,
  nameNode: SyntaxNode | null,
  objectKind: string,
  explicitColumnsContainer?: SyntaxNode | null
): boolean {
  const name = objectName(node, nameNode, ctx.source);
  if (!name) return true;
  const created = createDatabaseNode(ctx, node, name, 'struct', objectKind);
  withCreatedScope(ctx, created, () => {
    createExplicitColumns(explicitColumnsContainer ?? node, ctx);
    walkChildren(node, ctx);
  });
  return true;
}

function routineSignature(node: SyntaxNode, name: SqlName, source: string): string {
  const args = directChild(node, 'func_args_with_defaults');
  const returns = directChild(node, 'func_return', 'table_func_column_list');
  const isProcedure = hasDirectChild(node, 'kw_procedure');
  const prefix = isProcedure ? 'CREATE PROCEDURE' : 'CREATE FUNCTION';
  const argsText = args ? compactText(args, source, 180) : '()';
  const returnText = returns ? ` RETURNS ${compactText(returns, source, 100)}` : '';
  return `${prefix} ${name.qualified}${argsText}${returnText}`;
}

function createRoutine(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = objectName(node, directChild(node, 'func_name'), ctx.source);
  if (!name) return true;
  const objectKind = hasDirectChild(node, 'kw_procedure') ? 'procedure' : 'function';
  const created = createDatabaseNode(
    ctx,
    node,
    name,
    'function',
    objectKind,
    name.qualified,
    routineSignature(node, name, ctx.source)
  );
  withCreatedScope(ctx, created, () => walkChildren(node, ctx));
  return true;
}

function createType(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (!hasDirectChild(node, 'kw_type')) return false;
  const name = objectName(node, directChild(node, 'any_name'), ctx.source);
  if (!name) return true;
  const isEnum = hasDirectChild(node, 'kw_enum');
  const created = createDatabaseNode(
    ctx,
    node,
    name,
    isEnum ? 'enum' : 'type_alias',
    isEnum ? 'enum' : 'type'
  );
  withCreatedScope(ctx, created, () => {
    if (isEnum) createEnumMembers(node, ctx);
    walkChildren(node, ctx);
  });
  return true;
}

function createDomain(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = objectName(node, directChild(node, 'any_name'), ctx.source);
  if (!name) return true;
  const created = createDatabaseNode(ctx, node, name, 'type_alias', 'domain');
  withCreatedScope(ctx, created, () => walkChildren(node, ctx));
  return true;
}

function createSchema(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = objectName(node, directChild(node, 'ColId', 'opt_single_name'), ctx.source);
  if (!name) return true;
  const created = createDatabaseNode(ctx, node, name, 'namespace', 'schema');
  withCreatedScope(ctx, created, () => walkChildren(node, ctx));
  return true;
}

function createTrigger(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const triggerName = readSqlName(directChild(node, 'name'), ctx.source);
  const tableNode = directChild(node, 'qualified_name');
  const tableName = readSqlName(tableNode, ctx.source);
  if (!triggerName) return true;

  const qualifiedName = tableName
    ? `${tableName.qualified}.${triggerName.simple}`
    : triggerName.qualified;
  const created = createDatabaseNode(
    ctx,
    node,
    triggerName,
    'function',
    node.type === 'CreateEventTrigStmt' ? 'event-trigger' : 'trigger',
    qualifiedName
  );
  withCreatedScope(ctx, created, () => {
    if (created && tableNode && tableName) {
      addReference(ctx, created.id, tableName, 'references', tableNode);
    }
    const routineNode = directChild(node, 'func_name');
    const routineName = readSqlName(routineNode, ctx.source);
    if (created && routineNode && routineName) {
      addReference(ctx, created.id, routineName, 'calls', routineNode);
    }
    walkChildren(node, ctx);
  });
  return true;
}

function createPolicy(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const policyName = readSqlName(directChild(node, 'name'), ctx.source);
  const tableNode = directChild(node, 'qualified_name');
  const tableName = readSqlName(tableNode, ctx.source);
  if (!policyName) return true;
  const qualifiedName = tableName
    ? `${tableName.qualified}.${policyName.simple}`
    : policyName.qualified;
  const created = createDatabaseNode(
    ctx,
    node,
    policyName,
    'constant',
    'policy',
    qualifiedName
  );
  withCreatedScope(ctx, created, () => {
    if (created && tableNode && tableName) {
      addReference(ctx, created.id, tableName, 'references', tableNode);
    }
    walkChildren(node, ctx);
  });
  return true;
}

function createIndex(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const rawName = readSqlName(directChild(node, 'opt_single_name', 'name'), ctx.source);
  const relation = directChild(node, 'relation_expr');
  const tableNode = relation ? firstDescendant(relation, 'qualified_name') : null;
  const tableName = readSqlName(tableNode, ctx.source);
  if (!rawName) {
    walkChildren(node, ctx);
    return true;
  }
  const schema = tableName && tableName.parts.length > 1
    ? tableName.parts.slice(0, -1).join('.')
    : null;
  const qualifiedName = schema ? `${schema}.${rawName.simple}` : rawName.qualified;
  const created = createDatabaseNode(
    ctx,
    node,
    rawName,
    'constant',
    'index',
    qualifiedName
  );
  withCreatedScope(ctx, created, () => walkChildren(node, ctx));
  return true;
}

function createSequence(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = objectName(node, directChild(node, 'qualified_name'), ctx.source);
  if (!name) return true;
  const created = createDatabaseNode(ctx, node, name, 'variable', 'sequence');
  withCreatedScope(ctx, created, () => walkChildren(node, ctx));
  return true;
}

function createExtension(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = readSqlName(directChild(node, 'name'), ctx.source);
  if (!name) return true;
  const created = createDatabaseNode(ctx, node, name, 'constant', 'extension');
  withCreatedScope(ctx, created, () => walkChildren(node, ctx));
  return true;
}

const QUERY_SCOPE_TYPES = new Set([
  'select_no_parens',
  'InsertStmt',
  'UpdateStmt',
  'DeleteStmt',
]);

const QUERY_BOUNDARY_TYPES = new Set([
  ...QUERY_SCOPE_TYPES,
  'SelectStmt',
  'select_with_parens',
]);

/**
 * Find the WITH clause owned by one query level. The grammar wraps it in nodes
 * such as `select_no_parens`, so it is not necessarily a direct child. Nested
 * query statements are hard boundaries: their WITH clauses are not visible to
 * an outer relation that happens to share the same alias.
 */
function ownWithClause(query: SyntaxNode): SyntaxNode | null {
  const visit = (node: SyntaxNode): SyntaxNode | null => {
    for (const child of children(node)) {
      if (child.type === 'with_clause') return child;
      if (QUERY_BOUNDARY_TYPES.has(child.type)) continue;
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(query);
}

function cteNamesInClause(withClause: SyntaxNode, source: string): Set<string> {
  const names = new Set<string>();
  const visit = (node: SyntaxNode): void => {
    for (const child of children(node)) {
      if (child.type === 'common_table_expr') {
        const name = readSqlName(directChild(child, 'name'), source);
        if (name) names.add(name.qualified);
        // Do not enter the CTE body: a nested query may own another WITH clause.
        continue;
      }
      visit(child);
    }
  };
  visit(withClause);
  return names;
}

function cteNamesVisibleFrom(node: SyntaxNode, source: string): Set<string> {
  const names = new Set<string>();
  let ancestor: SyntaxNode | null = node;
  while (ancestor) {
    if (QUERY_SCOPE_TYPES.has(ancestor.type)) {
      const withClause = ownWithClause(ancestor);
      if (withClause) {
        for (const name of cteNamesInClause(withClause, source)) names.add(name);
      }
    }
    ancestor = ancestor.parent;
  }
  return names;
}

function emitRelationReference(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = firstDescendant(node, 'qualified_name');
  const name = readSqlName(nameNode, ctx.source);
  const fromNodeId = currentScopeId(ctx);
  if (!nameNode || !name || !fromNodeId) return true;
  if (name.parts.length === 1 && cteNamesVisibleFrom(node, ctx.source).has(name.qualified)) {
    return true;
  }
  addReference(ctx, fromNodeId, name, 'references', nameNode);
  walkChildren(node, ctx);
  return true;
}

function emitForeignKeyReference(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const fromNodeId = currentScopeId(ctx);
  const marker = directChild(node, 'kw_references');
  if (fromNodeId && marker) {
    const targetNode = children(node).find(
      (child) => child.type === 'qualified_name' && child.startIndex > marker.endIndex
    ) ?? null;
    const target = readSqlName(targetNode, ctx.source);
    if (targetNode && target) addReference(ctx, fromNodeId, target, 'references', targetNode);
  }
  walkChildren(node, ctx);
  return true;
}

function emitRoutineCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = directChild(node, 'func_name');
  const name = readSqlName(nameNode, ctx.source);
  const fromNodeId = currentScopeId(ctx);
  if (
    nameNode &&
    name &&
    fromNodeId &&
    !(name.parts.length === 1 && BUILTIN_ROUTINES.has(name.simple))
  ) {
    addReference(ctx, fromNodeId, name, 'calls', nameNode);
  }
  walkChildren(node, ctx);
  return true;
}

export const postgresExtractor: LanguageExtractor = {
  // All relevant grammar nodes have empty field maps, so visitNode owns the
  // PostgreSQL dispatch. Empty generic mappings prevent accidental extraction
  // from wrapper names such as `name` / `ColId`.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  fieldTypes: [],
  nameField: '',
  bodyField: '',
  paramsField: '',

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'CreateStmt':
      case 'CreateForeignTableStmt':
        return createTableLike(
          node,
          ctx,
          directChild(node, 'qualified_name'),
          node.type === 'CreateForeignTableStmt' ? 'foreign-table' : 'table'
        );

      case 'CreateAsStmt': {
        const target = directChild(node, 'create_as_target');
        return createTableLike(
          node,
          ctx,
          target ? firstDescendant(target, 'qualified_name') : null,
          'table',
          target
        );
      }

      case 'ViewStmt':
        return createTableLike(node, ctx, directChild(node, 'qualified_name'), 'view', node);

      case 'CreateMatViewStmt': {
        const target = directChild(node, 'create_mv_target');
        return createTableLike(
          node,
          ctx,
          target ? firstDescendant(target, 'qualified_name') : null,
          'materialized-view',
          target
        );
      }

      case 'CreateFunctionStmt':
        return createRoutine(node, ctx);

      case 'CreateSchemaStmt':
        return createSchema(node, ctx);

      case 'DefineStmt':
        return createType(node, ctx);

      case 'CreateDomainStmt':
        return createDomain(node, ctx);

      case 'CreateTrigStmt':
      case 'CreateEventTrigStmt':
        return createTrigger(node, ctx);

      case 'CreatePolicyStmt':
        return createPolicy(node, ctx);

      case 'IndexStmt':
        return createIndex(node, ctx);

      case 'CreateSeqStmt':
        return createSequence(node, ctx);

      case 'CreateExtensionStmt':
        return createExtension(node, ctx);

      case 'columnDef': {
        const nameNode = directChild(node, 'ColId');
        const scope = currentScopeNode(ctx);
        const isTableColumn = scope?.decorators?.some(
          (decorator) => decorator === 'postgres:table' || decorator === 'postgres:foreign-table'
        ) ?? false;
        if (nameNode && isTableColumn) createColumn(ctx, node, nameNode);
        walkChildren(node, ctx);
        return true;
      }

      case 'ConstraintElem':
      case 'ColConstraintElem':
        return emitForeignKeyReference(node, ctx);

      case 'relation_expr':
      case 'insert_target':
        return emitRelationReference(node, ctx);

      case 'func_application':
        return emitRoutineCall(node, ctx);

      default:
        return false;
    }
  },
};
