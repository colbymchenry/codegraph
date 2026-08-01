import type { Node as SyntaxNode, Parser } from 'web-tree-sitter';
import { parsePostgresQualifiedName, serializePostgresQualifiedName } from './identifiers';
import {
  analyzePostgresSearchPath,
  parsePostgresSearchPathSetting,
  postgresSearchPathAtOffset,
  type PostgresSearchPath,
} from './search-path';

export type PostgresRoutineBodyLanguage = 'sql' | 'plpgsql';
export type PostgresRoutineBodyReferenceKind = 'references' | 'calls' | 'sequence';

export interface PostgresRoutineBodyReference {
  kind: PostgresRoutineBodyReferenceKind;
  /** Decoded PostgreSQL identifier segments. */
  parts: string[];
  /** Canonical, quote-preserving qualified name used by resolution. */
  qualifiedName: string;
  simpleName: string;
  /**
   * Ordered, canonical qualified names supplied by a routine-local
   * `SET search_path`. Multiple entries are alternatives in PostgreSQL lookup
   * order, not independent dependencies. An empty array represents an
   * explicitly empty path and must not fall back to the file/session path.
   */
  searchPathCandidates?: string[];
  /** Absolute UTF-16 source offset in the containing SQL file. */
  startIndex: number;
  /** One-based source line in the containing SQL file. */
  line: number;
  /** Zero-based source column in the containing SQL file. */
  column: number;
}

export type PostgresRoutineBodyStatus =
  | 'analyzed'
  | 'missing-body'
  | 'unsupported-language'
  | 'parser-unavailable'
  | 'parse-error';

export interface PostgresRoutineBodyDiscovery {
  status: PostgresRoutineBodyStatus;
  language: PostgresRoutineBodyLanguage | null;
  bodyStartIndex: number | null;
  facts: PostgresRoutineBodyReference[];
  /** Injected fragments that needed conservative PostgreSQL error recovery. */
  recoveredFragments: number;
  /** Dynamic EXECUTE regions deliberately excluded from static dependencies. */
  skippedDynamicFragments: number;
}

export interface PostgresRoutineBodyParsers {
  postgres: Parser;
  plpgsql: Parser | null;
}

interface SqlName {
  parts: string[];
  qualified: string;
  simple: string;
}

interface StaticBody {
  text: string;
  startIndex: number;
}

interface LocalLocation {
  startIndex: number;
}

type LocationMapper = (node: SyntaxNode) => LocalLocation | null;

const NAME_SEGMENT_TYPES = new Set(['ColId', 'ColLabel', 'type_function_name']);

const SQL_STATEMENT_TYPES = new Set([
  'SelectStmt',
  'InsertStmt',
  'UpdateStmt',
  'DeleteStmt',
  'MergeStmt',
  'CallStmt',
]);

const QUERY_SCOPE_TYPES = new Set([
  'select_no_parens',
  'InsertStmt',
  'UpdateStmt',
  'DeleteStmt',
  'MergeStmt',
]);

const QUERY_BOUNDARY_TYPES = new Set([
  ...QUERY_SCOPE_TYPES,
  'SelectStmt',
  'select_with_parens',
]);

const STATIC_SEQUENCE_LITERAL_WRAPPERS = new Set([
  'func_arg_expr',
  'a_expr',
  'a_expr_prec',
  'c_expr',
  'AexprConst',
  'Sconst',
  'func_expr',
]);

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (child) result.push(child);
  }
  return result;
}

function directChild(node: SyntaxNode, ...types: string[]): SyntaxNode | null {
  return children(node).find((child) => types.includes(child.type)) ?? null;
}

function descendants(node: SyntaxNode, type: string): SyntaxNode[] {
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

function firstDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of children(node)) {
    if (child.type === type) return child;
    const nested = firstDescendant(child, type);
    if (nested) return nested;
  }
  return null;
}

function hasDirectChild(node: SyntaxNode, type: string): boolean {
  return directChild(node, type) !== null;
}

/**
 * Return the first routine argument only when it reduces to a regular string
 * literal through syntax-only parentheses and casts. A descendant search is
 * unsafe here: dynamic expressions such as `format('%s_seq', tenant)` and
 * `'prefix_' || tenant` also contain string literals but do not identify one
 * statically knowable sequence.
 */
export function postgresStaticSequenceLiteral(
  application: SyntaxNode
): SyntaxNode | null {
  const argumentList = directChild(application, 'func_arg_list');
  const firstArgument = argumentList
    ? firstDescendant(argumentList, 'func_arg_expr')
    : null;
  if (!firstArgument) return null;

  const unwrap = (node: SyntaxNode): SyntaxNode | null => {
    if (node.type === 'string_literal') return node;

    const nested = children(node);
    if (
      node.type === 'func_expr_common_subexpr' &&
      hasDirectChild(node, 'kw_cast') &&
      hasDirectChild(node, 'kw_as') &&
      hasDirectChild(node, 'Typename')
    ) {
      const expressions = nested.filter((child) => child.type === 'a_expr');
      return expressions.length === 1 ? unwrap(expressions[0]!) : null;
    }

    if (node.type === 'a_expr' || node.type === 'a_expr_prec') {
      const valueChildren = nested.filter((child) => child.type !== 'Typename');
      const isCast = nested.length === 2 && nested[1]?.type === 'Typename';
      if (isCast && valueChildren.length === 1) return unwrap(valueChildren[0]!);
    }

    return STATIC_SEQUENCE_LITERAL_WRAPPERS.has(node.type) && nested.length === 1
      ? unwrap(nested[0]!)
      : null;
  };

  return unwrap(firstArgument);
}

function canonicalSegment(node: SyntaxNode): string {
  const raw = node.text.trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw.toLowerCase();
}

function readSqlName(node: SyntaxNode | null): SqlName | null {
  if (!node) return null;
  const parts: string[] = [];

  const visit = (current: SyntaxNode): void => {
    if (NAME_SEGMENT_TYPES.has(current.type)) {
      const part = canonicalSegment(current);
      if (part) parts.push(part);
      return;
    }
    if (current.type === 'identifier' || current.type === 'quoted_identifier') {
      const part = canonicalSegment(current);
      if (part) parts.push(part);
      return;
    }
    for (const child of children(current)) visit(child);
  };

  visit(node);
  if (parts.length === 0) return null;
  return {
    parts,
    qualified: serializePostgresQualifiedName(parts),
    simple: parts[parts.length - 1]!,
  };
}

function decodeLanguageOption(option: SyntaxNode): string | null {
  const keyword = directChild(option, 'kw_language');
  if (!keyword) return null;
  const valueNode = children(option).find((child) => child.startIndex >= keyword.endIndex);
  if (!valueNode) return null;
  const value = valueNode.text.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'").toLowerCase();
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value.toLowerCase();
}

function routineLanguage(statement: SyntaxNode): string | null {
  const optionType = statement.type === 'DoStmt' ? 'dostmt_opt_item' : 'createfunc_opt_item';
  for (const option of descendants(statement, optionType)) {
    const language = decodeLanguageOption(option);
    if (language) return language;
  }
  return statement.type === 'DoStmt' ? 'plpgsql' : null;
}

/**
 * Read CREATE FUNCTION/PROCEDURE's routine-local SET search_path without
 * feeding it into the file-level session state machine. PostgreSQL's `FROM
 * CURRENT` captures the setting at CREATE time, so that one form deliberately
 * reads (but never mutates) the ambient path at the statement offset.
 */
function routineSearchPath(
  statement: SyntaxNode,
  source: string
): PostgresSearchPath | null {
  let configured: PostgresSearchPath | null = null;
  let ambient: PostgresSearchPath | null = null;

  for (const clause of descendants(statement, 'FunctionSetResetClause')) {
    const rest = directChild(clause, 'set_rest_more');
    const variable = rest ? firstDescendant(rest, 'var_name') : null;
    const name = readSqlName(variable);
    if (!rest || name?.parts.length !== 1 || name.simple !== 'search_path') continue;

    if (hasDirectChild(rest, 'kw_from') && hasDirectChild(rest, 'kw_current')) {
      ambient ??= postgresSearchPathAtOffset(
        analyzePostgresSearchPath(source, { copyPayloadsMasked: true }),
        statement.startIndex
      );
      configured = {
        schemas: [...ambient.schemas],
        explicit: ambient.explicit,
      };
      continue;
    }

    const genericSet = firstDescendant(rest, 'generic_set');
    if (!genericSet) continue;
    if (hasDirectChild(genericSet, 'kw_default')) {
      configured = parsePostgresSearchPathSetting('DEFAULT');
      continue;
    }
    const values = descendants(genericSet, 'var_value')
      .sort((left, right) => left.startIndex - right.startIndex)
      .map((value) => source.slice(value.startIndex, value.endIndex));
    if (values.length === 0) continue;
    configured = parsePostgresSearchPathSetting(values.join(','));
  }

  return configured;
}

function applyRoutineSearchPath(
  facts: PostgresRoutineBodyReference[],
  searchPath: PostgresSearchPath | null
): PostgresRoutineBodyReference[] {
  if (!searchPath) return facts;

  return facts.map((fact) => {
    // An explicitly schema-qualified body reference always wins over
    // search_path, exactly as it does at runtime.
    if (fact.parts.length !== 1) return fact;
    const candidates = searchPath.schemas.map((schema) =>
      serializePostgresQualifiedName([schema, ...fact.parts])
    );

    // A single statically named schema is exact, so expose the qualified fact
    // directly. `$user` is role-dependent and remains an ordered candidate
    // barrier for the resolver rather than pretending it is a literal schema.
    if (candidates.length === 1 && searchPath.schemas[0] !== '$user') {
      const parts = [searchPath.schemas[0]!, ...fact.parts];
      return {
        ...fact,
        parts,
        qualifiedName: serializePostgresQualifiedName(parts),
      };
    }

    return { ...fact, searchPathCandidates: candidates };
  });
}

function staticDollarBody(statement: SyntaxNode, source: string): StaticBody | null {
  let bodyLeaves: SyntaxNode[] = [];
  if (statement.type === 'CreateFunctionStmt') {
    for (const option of descendants(statement, 'createfunc_opt_item')) {
      if (!hasDirectChild(option, 'kw_as')) continue;
      const funcAs = directChild(option, 'func_as');
      if (funcAs) bodyLeaves.push(...descendants(funcAs, 'dollar_quoted_string'));
    }
  } else if (statement.type === 'DoStmt') {
    for (const option of descendants(statement, 'dostmt_opt_item')) {
      if (!hasDirectChild(option, 'kw_language')) {
        bodyLeaves.push(...descendants(option, 'dollar_quoted_string'));
      }
    }
  } else {
    return null;
  }

  if (bodyLeaves.length !== 1) return null;
  const leaf = bodyLeaves[0]!;
  const raw = source.slice(leaf.startIndex, leaf.endIndex);
  const opening = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(raw)?.[0];
  if (!opening || raw.length < opening.length * 2 || !raw.endsWith(opening)) return null;
  return {
    text: raw.slice(opening.length, -opening.length),
    startIndex: leaf.startIndex + opening.length,
  };
}

function nearestSqlStatement(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;
  while (current) {
    if (SQL_STATEMENT_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function hasErrorAncestorBefore(node: SyntaxNode, boundary: SyntaxNode): boolean {
  let current: SyntaxNode | null = node.parent;
  while (current && current !== boundary) {
    if (current.type === 'ERROR') return true;
    current = current.parent;
  }
  return false;
}

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

function cteNamesInClause(withClause: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const visit = (node: SyntaxNode): void => {
    for (const child of children(node)) {
      if (child.type === 'common_table_expr') {
        const name = readSqlName(directChild(child, 'name'));
        if (name) names.add(name.qualified);
        continue;
      }
      visit(child);
    }
  };
  visit(withClause);
  return names;
}

function cteNamesVisibleFrom(node: SyntaxNode): Set<string> {
  const names = new Set<string>();
  let ancestor: SyntaxNode | null = node;
  while (ancestor) {
    if (QUERY_SCOPE_TYPES.has(ancestor.type)) {
      const withClause = ownWithClause(ancestor);
      if (withClause) {
        for (const name of cteNamesInClause(withClause)) names.add(name);
      }
    }
    ancestor = ancestor.parent;
  }
  return names;
}

function lineColumnAt(source: string, startIndex: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < startIndex; index++) {
    if (source.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: startIndex - lineStart };
}

function collectPostgresFacts(
  root: SyntaxNode,
  source: string,
  mapLocation: LocationMapper,
  recoverFromErrors: boolean
): PostgresRoutineBodyReference[] {
  const facts: PostgresRoutineBodyReference[] = [];

  const emitStaticSequence = (application: SyntaxNode): void => {
    const functionName = readSqlName(directChild(application, 'func_name'));
    if (!functionName || !['nextval', 'currval', 'setval'].includes(functionName.simple)) return;
    const literal = postgresStaticSequenceLiteral(application);
    if (!literal) return;
    const raw = literal.text;
    if (raw.length < 2 || !raw.startsWith("'") || !raw.endsWith("'")) return;
    const decoded = raw.slice(1, -1).replace(/''/g, "'");
    const parts = parsePostgresQualifiedName(decoded);
    const location = mapLocation(literal);
    if (!parts || parts.length === 0 || !location) return;
    const startIndex = location.startIndex + 1;
    const position = lineColumnAt(source, startIndex);
    facts.push({
      kind: 'sequence',
      parts,
      qualifiedName: serializePostgresQualifiedName(parts),
      simpleName: parts[parts.length - 1]!,
      startIndex,
      ...position,
    });
  };

  const emit = (
    node: SyntaxNode,
    nameNode: SyntaxNode | null,
    kind: PostgresRoutineBodyReferenceKind,
    suppressCte: boolean
  ): void => {
    if (!nameNode) return;
    const statement = nearestSqlStatement(node);
    if (!statement) return;
    if (recoverFromErrors && hasErrorAncestorBefore(node, statement)) return;
    const name = readSqlName(nameNode);
    if (!name) return;
    if (
      suppressCte &&
      name.parts.length === 1 &&
      cteNamesVisibleFrom(node).has(name.qualified)
    ) return;
    const location = mapLocation(nameNode);
    if (!location || location.startIndex < 0 || location.startIndex > source.length) return;
    const position = lineColumnAt(source, location.startIndex);
    facts.push({
      kind,
      parts: name.parts,
      qualifiedName: name.qualified,
      simpleName: name.simple,
      startIndex: location.startIndex,
      ...position,
    });
  };

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'relation_expr') {
      emit(node, firstDescendant(node, 'qualified_name'), 'references', true);
    } else if (node.type === 'insert_target') {
      emit(node, firstDescendant(node, 'qualified_name'), 'references', false);
    } else if (node.type === 'func_application') {
      emit(node, directChild(node, 'func_name'), 'calls', false);
      emitStaticSequence(node);
    }
    for (const child of children(node)) visit(child);
  };

  visit(root);
  return facts;
}

function isDynamicExpression(expression: SyntaxNode): boolean {
  let ancestor: SyntaxNode | null = expression.parent;
  while (ancestor && ancestor.type !== 'source_file') {
    if (ancestor.type === 'stmt_dynexecute' || ancestor.type === 'for_dynamic') return true;
    if (
      (ancestor.type === 'stmt_return' || ancestor.type === 'stmt_open') &&
      hasDirectChild(ancestor, 'kw_execute')
    ) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

function isDirectSqlExpression(expression: SyntaxNode): boolean {
  const parent = expression.parent;
  if (!parent) return false;
  if (parent.type === 'stmt_execsql' || parent.type === 'for_query') return true;
  if (parent.type === 'decl_statement' && hasDirectChild(parent, 'kw_cursor')) return true;
  if (parent.type === 'stmt_open' && hasDirectChild(parent, 'kw_for')) return true;
  return parent.type === 'stmt_return' && hasDirectChild(parent, 'kw_query');
}

function deduplicateFacts(
  facts: PostgresRoutineBodyReference[]
): PostgresRoutineBodyReference[] {
  const result: PostgresRoutineBodyReference[] = [];
  const seen = new Set<string>();
  for (const fact of [...facts].sort((left, right) => left.startIndex - right.startIndex)) {
    const key = `${fact.kind}\u0000${fact.qualifiedName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}

function emptyDiscovery(
  status: PostgresRoutineBodyStatus,
  language: PostgresRoutineBodyLanguage | null,
  bodyStartIndex: number | null = null
): PostgresRoutineBodyDiscovery {
  return {
    status,
    language,
    bodyStartIndex,
    facts: [],
    recoveredFragments: 0,
    skippedDynamicFragments: 0,
  };
}

/**
 * Discover static table/routine dependencies inside a PostgreSQL routine or
 * anonymous DO body without executing source text.
 *
 * PL/pgSQL is parsed structurally first so record assignments and dynamic SQL
 * cannot bleed into PostgreSQL statement recovery. Each explicit
 * `sql_expression` injection region is then parsed independently. Error-free
 * expression regions are required; full SQL regions may conservatively retain
 * name nodes outside ERROR subtrees so PL/pgSQL's SELECT/RETURNING INTO syntax
 * still yields its real table dependencies.
 */
export function discoverPostgresRoutineBodyReferences(
  statement: SyntaxNode,
  source: string,
  parsers: PostgresRoutineBodyParsers
): PostgresRoutineBodyDiscovery {
  const rawLanguage = routineLanguage(statement);
  const language = rawLanguage === 'sql' || rawLanguage === 'plpgsql'
    ? rawLanguage
    : null;
  if (!language || (statement.type === 'DoStmt' && language !== 'plpgsql')) {
    return emptyDiscovery('unsupported-language', language);
  }

  const body = staticDollarBody(statement, source);
  if (!body) return emptyDiscovery('missing-body', language);
  const searchPath = routineSearchPath(statement, source);

  if (language === 'sql') {
    const tree = parsers.postgres.parse(body.text);
    if (!tree) return emptyDiscovery('parse-error', language, body.startIndex);
    try {
      if (tree.rootNode.hasError) {
        return emptyDiscovery('parse-error', language, body.startIndex);
      }
      const facts = applyRoutineSearchPath(
        collectPostgresFacts(
          tree.rootNode,
          source,
          (node) => ({ startIndex: body.startIndex + node.startIndex }),
          false
        ),
        searchPath
      );
      return {
        status: 'analyzed',
        language,
        bodyStartIndex: body.startIndex,
        facts: deduplicateFacts(facts),
        recoveredFragments: 0,
        skippedDynamicFragments: 0,
      };
    } finally {
      tree.delete();
    }
  }

  if (!parsers.plpgsql) {
    return emptyDiscovery('parser-unavailable', language, body.startIndex);
  }
  const plpgsqlTree = parsers.plpgsql.parse(body.text);
  if (!plpgsqlTree) return emptyDiscovery('parse-error', language, body.startIndex);
  try {
    if (plpgsqlTree.rootNode.hasError) {
      return emptyDiscovery('parse-error', language, body.startIndex);
    }

    const facts: PostgresRoutineBodyReference[] = [];
    let recoveredFragments = 0;
    let skippedDynamicFragments = 0;
    for (const expression of descendants(plpgsqlTree.rootNode, 'sql_expression')) {
      if (isDynamicExpression(expression)) {
        skippedDynamicFragments++;
        continue;
      }

      const direct = isDirectSqlExpression(expression);
      const prefix = direct ? '' : 'SELECT ';
      const suffix = direct ? '' : ';';
      const fragmentTree = parsers.postgres.parse(`${prefix}${expression.text}${suffix}`);
      if (!fragmentTree) continue;
      try {
        const hasErrors = fragmentTree.rootNode.hasError;
        // Expression wrappers should be valid PostgreSQL expressions. Reject
        // their error recovery wholesale; only full SQL fragments need the
        // narrow SELECT/RETURNING INTO recovery used by PL/pgSQL.
        if (hasErrors && !direct) continue;
        if (hasErrors) recoveredFragments++;
        const fragmentStart = body.startIndex + expression.startIndex;
        facts.push(...collectPostgresFacts(
          fragmentTree.rootNode,
          source,
          (node) => {
            const relative = node.startIndex - prefix.length;
            if (relative < 0 || relative >= expression.text.length) return null;
            return { startIndex: fragmentStart + relative };
          },
          hasErrors
        ));
      } finally {
        fragmentTree.delete();
      }
    }

    return {
      status: 'analyzed',
      language,
      bodyStartIndex: body.startIndex,
      facts: deduplicateFacts(applyRoutineSearchPath(facts, searchPath)),
      recoveredFragments,
      skippedDynamicFragments,
    };
  } finally {
    plpgsqlTree.delete();
  }
}
