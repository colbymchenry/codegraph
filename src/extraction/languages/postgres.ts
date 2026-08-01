import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind } from '../../types';
import {
  POSTGRES_FOREIGN_KEY_DECORATOR,
  encodePostgresForeignKeyDescriptor,
  type PostgresForeignKeyDescriptor,
} from '../../postgres/foreign-key';
import {
  appendPostgresIdentifier,
  parsePostgresQualifiedName,
  serializePostgresQualifiedName,
} from '../../postgres/identifiers';
import {
  analyzePostgresSearchPath,
  postgresSearchPathAtOffset,
  type PostgresSearchPathState,
} from '../../postgres/search-path';
import {
  analyzePostgresTemporaryRelationVisibility,
  postgresTemporaryRelationVisibleAt,
  type PostgresTemporaryRelationVisibilityState,
} from '../../postgres/temporary-relations';
import {
  POSTGRES_TABLE_RELATION_DECORATOR,
  encodePostgresTableRelationDescriptor,
  type PostgresTableRelationDescriptor,
  type PostgresTableRelationKind,
} from '../../postgres/table-relation';
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

/** Per-extraction reference de-duplication. `ctx.nodes` is stable for a file. */
const emittedReferenceKeys = new WeakMap<readonly object[], Set<string>>();
const extractionSearchPaths = new WeakMap<readonly object[], PostgresSearchPathState>();
interface ExtractionTemporaryVisibilityCache {
  scannedNodeCount: number;
  candidates: Node[];
  state: PostgresTemporaryRelationVisibilityState;
}
const extractionTemporaryVisibility = new WeakMap<
  readonly object[],
  ExtractionTemporaryVisibilityCache
>();

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

function nearestAncestor(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
  let ancestor = node.parent;
  while (ancestor) {
    if (types.includes(ancestor.type)) return ancestor;
    ancestor = ancestor.parent;
  }
  return null;
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
  return sqlNameFromParts(parts);
}

function sqlNameFromParts(parts: string[]): SqlName {
  return {
    parts,
    qualified: serializePostgresQualifiedName(parts),
    simple: parts[parts.length - 1]!,
  };
}

interface NestedSchema {
  found: boolean;
  name: SqlName | null;
}

function schemaName(node: SyntaxNode, source: string): SqlName | null {
  return readSqlName(directChild(node, 'ColId', 'opt_single_name', 'RoleSpec'), source);
}

function nestedSchema(node: SyntaxNode, source: string): NestedSchema {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'CreateSchemaStmt') {
      return { found: true, name: schemaName(parent, source) };
    }
    parent = parent.parent;
  }
  return { found: false, name: null };
}

function searchPathState(ctx: ExtractorContext): PostgresSearchPathState {
  let state = extractionSearchPaths.get(ctx.nodes);
  if (!state) {
    state = analyzePostgresSearchPath(ctx.source);
    extractionSearchPaths.set(ctx.nodes, state);
  }
  return state;
}

/**
 * Extraction appends to `ctx.nodes`. Scan each appended node once and rebuild
 * the source timeline only when a new temporary declaration appears; relation
 * lookups must not rescan a large SQL file for every statement.
 */
function temporaryVisibilityState(ctx: ExtractorContext): ExtractionTemporaryVisibilityCache {
  let cached = extractionTemporaryVisibility.get(ctx.nodes);
  if (!cached) {
    cached = {
      scannedNodeCount: 0,
      candidates: [],
      state: { changesByNodeId: new Map() },
    };
    extractionTemporaryVisibility.set(ctx.nodes, cached);
  }

  let addedTemporary = false;
  for (let index = cached.scannedNodeCount; index < ctx.nodes.length; index++) {
    const candidate = ctx.nodes[index]!;
    if (candidate.language === 'postgres' &&
      candidate.filePath === ctx.filePath &&
      candidate.decorators?.includes('postgres:temporary') === true) {
      cached.candidates.push(candidate);
      addedTemporary = true;
    }
  }
  cached.scannedNodeCount = ctx.nodes.length;
  if (addedTemporary) {
    cached.state = analyzePostgresTemporaryRelationVisibility(
      ctx.source,
      cached.candidates,
      searchPathState(ctx)
    );
  }
  return cached;
}

function visibleTemporaryCandidates(
  ctx: ExtractorContext,
  name: SqlName,
  offset: number
): Node[] {
  const cached = temporaryVisibilityState(ctx);
  if (cached.candidates.length === 0) return [];
  const targetSchema = name.parts.length > 1 ? name.parts[0]! : null;
  if (targetSchema !== null && targetSchema !== 'pg_temp' &&
    !/^pg_temp_[0-9]+$/.test(targetSchema)) return [];

  return cached.candidates.filter((candidate) => {
    if (candidate.name !== name.simple) return false;
    const parts = parsePostgresQualifiedName(candidate.qualifiedName);
    if (!parts || parts.length < 2) return false;
    if (targetSchema !== null &&
      name.parts.slice(1).some((part, index) => part !== parts[index + 1])) return false;
    return postgresTemporaryRelationVisibleAt(cached.state, candidate.id, offset);
  });
}

function nameInSearchPathSchema(
  name: SqlName,
  positionNode: SyntaxNode,
  ctx: ExtractorContext
): SqlName {
  if (name.parts.length > 1) return name;
  const positions = searchPathState(ctx);
  const path = postgresSearchPathAtOffset(positions, positionNode.startIndex);
  const hasSameFileTemporary = visibleTemporaryCandidates(
    ctx,
    name,
    positionNode.startIndex
  ).length > 0;
  if (hasSameFileTemporary) return sqlNameFromParts(['pg_temp', ...name.parts]);
  if (path.schemas.length !== 1 || path.schemas[0] === '$user') return name;
  const schema = path.schemas[0]!;
  return sqlNameFromParts([schema, ...name.parts]);
}

function objectName(
  node: SyntaxNode,
  nameNode: SyntaxNode | null,
  ctx: ExtractorContext
): SqlName | null {
  const name = readSqlName(nameNode, ctx.source);
  if (!name || name.parts.length > 1 || node.type === 'CreateSchemaStmt') return name;
  const nested = nestedSchema(node, ctx.source);
  if (nested.found) {
    // AUTHORIZATION CURRENT_USER has a runtime-only schema name. Keep nested
    // declarations searchable but unqualified rather than falsely assigning
    // them to the ambient/default search_path.
    return nested.name
      ? sqlNameFromParts([...nested.name.parts, ...name.parts])
      : name;
  }
  return nameInSearchPathSchema(name, node, ctx);
}

function isTemporaryRelationName(name: SqlName | null): boolean {
  const schema = name && name.parts.length > 1 ? name.parts[0]! : null;
  return schema === 'pg_temp' || (schema !== null && /^pg_temp_[0-9]+$/.test(schema));
}

function hasTemporaryOption(node: SyntaxNode): boolean {
  const options = directChild(node, 'OptTemp');
  return options !== null && (
    hasDirectChild(options, 'kw_temp') || hasDirectChild(options, 'kw_temporary')
  );
}

/**
 * PostgreSQL tables, views, and sequences share the temporary relation
 * namespace.  TEMP declarations with an unqualified name live in the
 * session's pg_temp schema; explicitly targeting pg_temp has the same
 * semantics even when the TEMP keyword is omitted.
 */
function relationDeclarationName(
  node: SyntaxNode,
  nameNode: SyntaxNode | null,
  ctx: ExtractorContext
): { name: SqlName | null; temporary: boolean } {
  const rawName = readSqlName(nameNode, ctx.source);
  const temporary = hasTemporaryOption(node) || isTemporaryRelationName(rawName);
  const name = temporary && rawName?.parts.length === 1
    ? sqlNameFromParts(['pg_temp', ...rawName.parts])
    : objectName(node, nameNode, ctx);
  return { name, temporary };
}

function markTemporary(created: Node | null | undefined, temporary: boolean): void {
  if (created && temporary && !created.decorators?.includes('postgres:temporary')) {
    created.decorators = [...(created.decorators ?? []), 'postgres:temporary'];
  }
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
  // Search-path segment is semantic in SQL: the same unqualified name on
  // opposite sides of SET search_path can resolve to different schemas, while
  // ordinary repeated reads within one segment remain de-duplicated.
  const activePath = postgresSearchPathAtOffset(
    searchPathState(ctx),
    positionNode.startIndex
  );
  const temporaryBinding = visibleTemporaryCandidates(
    ctx,
    target,
    positionNode.startIndex
  ).map((candidate) => candidate.id).sort().join('\u001f');
  const key = `${fromNodeId}\u0000${kind}\u0000${target.qualified}` +
    `\u0000${activePath.explicit ? 'explicit' : 'default'}` +
    `\u0000${activePath.schemas.join('\u001f')}` +
    `\u0000temp:${temporaryBinding}`;
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
  // Node IDs use the createNode `name` argument plus file/line. PostgreSQL can
  // switch search_path and declare same-named objects more than once on a
  // generated/minified line, so simple names are not a safe discriminator.
  const idDiscriminator = `${qualifiedName}@${node.startPosition.row + 1}:` +
    `${node.startPosition.column + 1}`;
  return ctx.createNode(kind, idDiscriminator, node, {
    name: name.simple,
    qualifiedName,
    signature,
    decorators: [`postgres:${objectKind}`],
    isExported: true,
  });
}

function walkChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of children(node)) ctx.visitNode(child);
}

function createColumn(
  ctx: ExtractorContext,
  node: SyntaxNode,
  nameNode: SyntaxNode,
  parentQualifiedOverride?: string
): void {
  const name = readSqlName(nameNode, ctx.source);
  if (!name) return;
  const parentQualified = parentQualifiedOverride ?? currentScopeQualifiedName(ctx);
  const qualifiedName = parentQualified
    ? appendPostgresIdentifier(parentQualified, name.simple)
    : name.qualified;
  const idDiscriminator = `${qualifiedName}@${node.startPosition.row + 1}:` +
    `${node.startPosition.column + 1}`;
  ctx.createNode('field', idDiscriminator, node, {
    name: name.simple,
    qualifiedName,
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
    const qualifiedName = parentQualified
      ? appendPostgresIdentifier(parentQualified, value)
      : serializePostgresQualifiedName([value]);
    const idDiscriminator = `${qualifiedName}@${literal.startPosition.row + 1}:` +
      `${literal.startPosition.column + 1}`;
    ctx.createNode('enum_member', idDiscriminator, literal, {
      name: value,
      qualifiedName,
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

function createTableRelationFact(
  ctx: ExtractorContext,
  clause: SyntaxNode,
  sourceTable: SqlName,
  targetTable: SqlName,
  relation: PostgresTableRelationKind,
  sourcePosition: SyntaxNode,
  targetPosition: SyntaxNode,
  extra: Pick<PostgresTableRelationDescriptor, 'mode' | 'triggerName'> = {}
): void {
  const descriptor: PostgresTableRelationDescriptor = {
    relation,
    sourceTable: sourceTable.qualified,
    targetTable: targetTable.qualified,
    ...extra,
  };
  const label = `${relation.toUpperCase()} → ${targetTable.qualified}`;
  const identity = `${label} @${clause.startPosition.row + 1}:` +
    `${clause.startPosition.column + 1}`;
  const created = ctx.createNode('constant', `${sourceTable.qualified}.${identity}`, clause, {
    name: label,
    qualifiedName: appendPostgresIdentifier(sourceTable.qualified, identity),
    signature: compactText(clause, ctx.source),
    decorators: [
      POSTGRES_TABLE_RELATION_DECORATOR,
      encodePostgresTableRelationDescriptor(descriptor),
    ],
    isExported: true,
  });
  withCreatedScope(ctx, created, () => {
    if (!created) return;
    addReference(ctx, created.id, sourceTable, 'references', sourcePosition);
    addReference(ctx, created.id, targetTable, 'references', targetPosition);
  });
}

function createTableDeclarationRelations(
  node: SyntaxNode,
  ctx: ExtractorContext,
  sourceTable: SqlName,
  sourcePosition: SyntaxNode
): void {
  const directNames = children(node).filter((child) => child.type === 'qualified_name');
  if (hasDirectChild(node, 'kw_partition') && hasDirectChild(node, 'kw_of')) {
    const targetNode = directNames.find((candidate) => candidate.startIndex > sourcePosition.endIndex);
    const target = readSqlName(targetNode ?? null, ctx.source);
    if (targetNode && target) {
      createTableRelationFact(
        ctx, node, sourceTable, target, 'partition-of', sourcePosition, targetNode
      );
    }
  }

  const inheritance = directChild(node, 'OptInherit');
  if (inheritance) {
    for (const targetNode of allDescendants(inheritance, 'qualified_name')) {
      const target = readSqlName(targetNode, ctx.source);
      if (target) {
        createTableRelationFact(
          ctx, targetNode, sourceTable, target, 'inherits', sourcePosition, targetNode
        );
      }
    }
  }

  for (const like of allDescendants(node, 'TableLikeClause')) {
    const targetNode = directChild(like, 'qualified_name');
    const target = readSqlName(targetNode, ctx.source);
    if (targetNode && target) {
      createTableRelationFact(ctx, like, sourceTable, target, 'like', sourcePosition, targetNode);
    }
  }
}

function createTableLike(
  node: SyntaxNode,
  ctx: ExtractorContext,
  nameNode: SyntaxNode | null,
  objectKind: string,
  explicitColumnsContainer?: SyntaxNode | null
): boolean {
  const { name, temporary } = relationDeclarationName(node, nameNode, ctx);
  if (!name) return true;
  const created = createDatabaseNode(ctx, node, name, 'struct', objectKind);
  markTemporary(created, temporary);
  withCreatedScope(ctx, created, () => {
    if (nameNode) createTableDeclarationRelations(node, ctx, name, nameNode);
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
  const name = objectName(node, directChild(node, 'func_name'), ctx);
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
  const name = objectName(node, directChild(node, 'any_name'), ctx);
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
  const name = objectName(node, directChild(node, 'any_name'), ctx);
  if (!name) return true;
  const created = createDatabaseNode(ctx, node, name, 'type_alias', 'domain');
  withCreatedScope(ctx, created, () => walkChildren(node, ctx));
  return true;
}

function createSchema(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = schemaName(node, ctx.source);
  if (!name) {
    walkChildren(node, ctx);
    return true;
  }
  const created = createDatabaseNode(ctx, node, name, 'namespace', 'schema');
  withCreatedScope(ctx, created, () => walkChildren(node, ctx));
  return true;
}

function createTrigger(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const triggerName = readSqlName(directChild(node, 'name'), ctx.source);
  const tableNode = directChild(node, 'qualified_name');
  const tableName = readSqlName(tableNode, ctx.source);
  if (!triggerName) return true;

  const displayTableName = tableName ? nameInSearchPathSchema(tableName, node, ctx) : null;
  const qualifiedName = displayTableName
    ? appendPostgresIdentifier(displayTableName.qualified, triggerName.simple)
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
    const constraintSource = directChild(node, 'OptConstrFromTable');
    const sourceTableNode = constraintSource
      ? directChild(constraintSource, 'qualified_name')
      : null;
    const sourceTable = readSqlName(sourceTableNode, ctx.source);
    if (created && sourceTableNode && sourceTable) {
      addReference(ctx, created.id, sourceTable, 'references', sourceTableNode);
    }
    if (tableNode && displayTableName && sourceTableNode && sourceTable) {
      createTableRelationFact(
        ctx,
        constraintSource ?? node,
        displayTableName,
        sourceTable,
        'constraint-trigger',
        tableNode,
        sourceTableNode,
        { triggerName: triggerName.simple }
      );
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
  const displayTableName = tableName ? nameInSearchPathSchema(tableName, node, ctx) : null;
  const qualifiedName = displayTableName
    ? appendPostgresIdentifier(displayTableName.qualified, policyName.simple)
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
  const displayTableName = tableName ? nameInSearchPathSchema(tableName, node, ctx) : null;
  const schema = displayTableName && displayTableName.parts.length > 1
    ? serializePostgresQualifiedName(displayTableName.parts.slice(0, -1))
    : null;
  const qualifiedName = schema
    ? appendPostgresIdentifier(schema, rawName.simple)
    : rawName.qualified;
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
  const { name, temporary } = relationDeclarationName(
    node,
    directChild(node, 'qualified_name'),
    ctx
  );
  if (!name) return true;
  const created = createDatabaseNode(ctx, node, name, 'variable', 'sequence');
  markTemporary(created, temporary);
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

function columnNames(container: SyntaxNode | null, source: string): string[] {
  if (!container) return [];
  const result: string[] = [];
  for (const column of allDescendants(container, 'columnElem')) {
    const name = readSqlName(column, source);
    if (name) result.push(name.simple);
  }
  return result;
}

function foreignKeyAction(
  text: string,
  event: 'DELETE' | 'UPDATE'
): PostgresForeignKeyDescriptor['onDelete'] {
  const match = new RegExp(
    `\\bON\\s+${event}\\s+(NO\\s+ACTION|RESTRICT|CASCADE|SET\\s+NULL|SET\\s+DEFAULT)\\b`,
    'i'
  ).exec(text);
  return match?.[1]
    ? match[1].replace(/\s+/g, ' ').toLowerCase() as PostgresForeignKeyDescriptor['onDelete']
    : undefined;
}

/**
 * Create a durable constraint fact instead of attributing REFERENCES to the
 * migration file. The constraint points at both endpoint relations; a
 * post-resolution pass turns those two exact facts into a direct table edge.
 */
function createForeignKey(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const marker = directChild(node, 'kw_references');
  if (!marker || (node.type === 'ConstraintElem' && !hasDirectChild(node, 'kw_foreign'))) {
    walkChildren(node, ctx);
    return true;
  }

  const targetNode = children(node).find(
    (child) => child.type === 'qualified_name' && child.startIndex > marker.endIndex
  ) ?? null;
  const target = readSqlName(targetNode, ctx.source);
  if (!targetNode || !target) {
    walkChildren(node, ctx);
    return true;
  }

  const alter = nearestAncestor(node, 'AlterTableStmt');
  const alterRelation = alter ? directChild(alter, 'relation_expr') : null;
  const alterTableNode = alterRelation ? firstDescendant(alterRelation, 'qualified_name') : null;
  const rawAlterTable = readSqlName(alterTableNode, ctx.source);
  const alterTable = rawAlterTable && alter
    ? nameInSearchPathSchema(rawAlterTable, alter, ctx)
    : rawAlterTable;
  const scope = currentScopeNode(ctx);
  const scopeIsTable = scope?.language === 'postgres' && scope.kind === 'struct' &&
    (scope.decorators?.includes('postgres:table') === true ||
      scope.decorators?.includes('postgres:foreign-table') === true);
  const sourceTable: SqlName | null = alterTable ?? (scopeIsTable && scope ? {
    parts: parsePostgresQualifiedName(scope.qualifiedName) ?? [scope.qualifiedName],
    qualified: scope.qualifiedName,
    simple: scope.name,
  } : null);
  if (!sourceTable) {
    walkChildren(node, ctx);
    return true;
  }

  const wrapper = nearestAncestor(node, 'TableConstraint', 'ColConstraint');
  const constraintName = readSqlName(wrapper ? directChild(wrapper, 'name') : null, ctx.source);
  let sourceColumns: string[];
  if (node.type === 'ConstraintElem') {
    sourceColumns = columnNames(directChild(node, 'columnList'), ctx.source);
  } else {
    const column = nearestAncestor(node, 'columnDef');
    const columnName = readSqlName(column ? directChild(column, 'ColId') : null, ctx.source);
    sourceColumns = columnName ? [columnName.simple] : [];
  }

  const targetColumnsContainer = children(node).find(
    (child) => child.startIndex >= targetNode.endIndex &&
      (child.type === 'opt_column_and_period_list' || child.type === 'opt_column_list')
  ) ?? null;
  const targetColumns = columnNames(targetColumnsContainer, ctx.source);
  const raw = getNodeText(nearestAncestor(node, 'alter_table_cmd') ?? wrapper ?? node, ctx.source);
  const compact = raw.replace(/\s+/g, ' ').trim();
  const matchType = /\bMATCH\s+(FULL|PARTIAL|SIMPLE)\b/i.exec(compact)?.[1]?.toLowerCase() as
    PostgresForeignKeyDescriptor['match'];
  const initially = /\bINITIALLY\s+(DEFERRED|IMMEDIATE)\b/i.exec(compact)?.[1]?.toLowerCase() as
    PostgresForeignKeyDescriptor['initially'];
  const onDelete = foreignKeyAction(compact, 'DELETE');
  const onUpdate = foreignKeyAction(compact, 'UPDATE');
  const descriptor: PostgresForeignKeyDescriptor = {
    sourceTable: sourceTable.qualified,
    targetTable: target.qualified,
    ...(constraintName ? { constraintName: constraintName.simple } : {}),
    sourceColumns,
    targetColumns,
    ...(matchType ? { match: matchType } : {}),
    ...(onDelete ? { onDelete } : {}),
    ...(onUpdate ? { onUpdate } : {}),
    ...(/\bNOT\s+DEFERRABLE\b/i.test(compact)
      ? { deferrable: false }
      : /\bDEFERRABLE\b/i.test(compact)
        ? { deferrable: true }
        : {}),
    ...(initially ? { initially } : {}),
    ...(/\bNOT\s+VALID\b/i.test(compact) ? { notValid: true } : {}),
  };

  const sourceLabel = sourceColumns.length > 0 ? sourceColumns.join(', ') : '?';
  const simple = constraintName?.simple ?? `FOREIGN KEY (${sourceLabel})`;
  const qualifiedIdentity = constraintName?.simple ??
    `FOREIGN KEY (${sourceLabel}) -> ${target.qualified} ` +
      `@${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
  const name: SqlName = {
    parts: [...sourceTable.parts, qualifiedIdentity],
    qualified: appendPostgresIdentifier(sourceTable.qualified, qualifiedIdentity),
    simple,
  };
  const idDiscriminator = `${sourceTable.qualified}.${qualifiedIdentity} ` +
    `@${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
  // createNode's stable ID is based on its `name` argument and start line. Use
  // the disambiguated identity there, then retain the human-facing name in the
  // stored node. Generated/minified DDL can declare two anonymous constraints
  // on one line; using `simple` for the ID would silently collapse one of them.
  const created = ctx.createNode('constant', idDiscriminator, wrapper ?? node, {
    name: simple,
    qualifiedName: name.qualified,
    signature: compactText(wrapper ?? node, ctx.source),
    decorators: [
      POSTGRES_FOREIGN_KEY_DECORATOR,
      encodePostgresForeignKeyDescriptor(descriptor),
    ],
    isExported: true,
  });
  withCreatedScope(ctx, created, () => {
    if (!created) return;
    addReference(ctx, created.id, sourceTable, 'references', alterTableNode ?? node);
    addReference(ctx, created.id, target, 'references', targetNode);
  });
  return true;
}

/**
 * Model ALTER TABLE ADD COLUMN as a migration delta rather than attaching the
 * new field to an arbitrary historical CREATE TABLE node. The delta references
 * its target relation and contains a normally searchable table-qualified field;
 * a future ordered-migration layer can fold these deltas into an effective
 * schema without changing the extracted facts.
 */
function createAlterTableRelations(
  node: SyntaxNode,
  ctx: ExtractorContext,
  tableName: SqlName,
  tableNode: SyntaxNode
): void {
  const partition = directChild(node, 'partition_cmd');
  if (partition) {
    const childNode = directChild(partition, 'qualified_name');
    const rawChild = readSqlName(childNode, ctx.source);
    const child = rawChild ? nameInSearchPathSchema(rawChild, partition, ctx) : null;
    const attach = hasDirectChild(partition, 'kw_attach');
    const detach = hasDirectChild(partition, 'kw_detach');
    if (childNode && child && (attach || detach)) {
      const compact = compactText(partition, ctx.source).toLowerCase();
      const mode = /\bconcurrently\b/.test(compact)
        ? 'concurrently' as const
        : /\bfinalize\b/.test(compact)
          ? 'finalize' as const
          : undefined;
      createTableRelationFact(
        ctx,
        partition,
        child,
        tableName,
        attach ? 'attach-partition' : 'detach-partition',
        childNode,
        tableNode,
        mode ? { mode } : {}
      );
    }
  }

  const commands = directChild(node, 'alter_table_cmds');
  if (!commands) return;
  for (const command of allDescendants(commands, 'alter_table_cmd')) {
    if (!hasDirectChild(command, 'kw_inherit')) continue;
    const parentNode = directChild(command, 'qualified_name');
    const parent = readSqlName(parentNode, ctx.source);
    if (parentNode && parent) {
      createTableRelationFact(
        ctx,
        command,
        tableName,
        parent,
        hasDirectChild(command, 'kw_no') ? 'no-inherit' : 'inherit',
        tableNode,
        parentNode
      );
    }
  }
}

function createAlterTableDeltas(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const relation = directChild(node, 'relation_expr');
  const tableNode = relation ? firstDescendant(relation, 'qualified_name') : null;
  const rawTableName = readSqlName(tableNode, ctx.source);
  const tableName = rawTableName ? nameInSearchPathSchema(rawTableName, node, ctx) : null;
  const ownerId = currentScopeId(ctx);
  if (!tableNode || !tableName || !ownerId) {
    walkChildren(node, ctx);
    return true;
  }

  createAlterTableRelations(node, ctx, tableName, tableNode);

  // Retain the statement-level dependency that ALTER TABLE emitted before
  // column deltas were modeled.
  addReference(ctx, ownerId, tableName, 'references', tableNode);

  const commands = directChild(node, 'alter_table_cmds');
  if (!commands) return true;
  for (const command of allDescendants(commands, 'alter_table_cmd')) {
    const column = directChild(command, 'columnDef');
    const columnNameNode = column ? directChild(column, 'ColId') : null;
    const columnName = readSqlName(columnNameNode, ctx.source);
    if (!hasDirectChild(command, 'kw_add') || !column || !columnNameNode || !columnName) {
      ctx.visitNode(command);
      continue;
    }

    const deltaSimple = `ADD COLUMN ${columnName.simple}`;
    const deltaName: SqlName = {
      parts: [...tableName.parts, deltaSimple],
      qualified: appendPostgresIdentifier(tableName.qualified, deltaSimple),
      simple: deltaSimple,
    };
    const created = createDatabaseNode(
      ctx,
      command,
      deltaName,
      'constant',
      'alter-table-add-column'
    );
    withCreatedScope(ctx, created, () => {
      if (created) addReference(ctx, created.id, tableName, 'references', tableNode);
      createColumn(ctx, column, columnNameNode, tableName.qualified);
      walkChildren(command, ctx);
    });
  }
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

function emitRoutineCall(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = directChild(node, 'func_name');
  const name = readSqlName(nameNode, ctx.source);
  const fromNodeId = currentScopeId(ctx);
  // Emit every routine-shaped call. PostgreSQL permits user routines to share
  // names with pg_catalog routines (overload resolution and search_path decide
  // the target), so filtering an unqualified name here would erase valid
  // project edges before the resolver can inspect the indexed declarations.
  if (nameNode && name && fromNodeId) {
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

      case 'AlterTableStmt':
        return createAlterTableDeltas(node, ctx);

      case 'columnDef': {
        const nameNode = directChild(node, 'ColId');
        const scope = currentScopeNode(ctx);
        const isTableColumn = scope?.decorators?.some(
          (decorator) => decorator === 'postgres:table' ||
            decorator === 'postgres:foreign-table'
        ) ?? false;
        if (nameNode && isTableColumn) createColumn(ctx, node, nameNode);
        walkChildren(node, ctx);
        return true;
      }

      case 'ConstraintElem':
      case 'ColConstraintElem':
        return createForeignKey(node, ctx);

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
