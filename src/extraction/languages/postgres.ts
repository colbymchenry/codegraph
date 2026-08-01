import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, NodeKind } from '../../types';
import {
  POSTGRES_DROP_CONSTRAINT_DECORATOR,
  POSTGRES_RENAME_CONSTRAINT_DECORATOR,
  encodePostgresDropConstraintDescriptor,
  encodePostgresRenameConstraintDescriptor,
} from '../../postgres/constraint-mutation';
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
  POSTGRES_SEQUENCE_REFERENCE_KIND,
  POSTGRES_TYPE_REFERENCE_KIND,
  type PostgresObjectReferenceKind,
} from '../../postgres/reference-intent';
import {
  POSTGRES_DROP_RELATION_DECORATOR,
  encodePostgresDropRelationDescriptor,
  type PostgresDroppedRelationKind,
} from '../../postgres/relation-lifecycle';
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
import {
  POSTGRES_ENUM_VALUE_MUTATION_DECORATOR,
  POSTGRES_TYPE_RENAME_DECORATOR,
  encodePostgresEnumValueMutationDescriptor,
  encodePostgresTypeRenameDescriptor,
} from '../../postgres/type-lifecycle';
import {
  discoverPostgresRoutineBodyReferences,
  postgresStaticSequenceLiteral,
} from '../../postgres/routine-body';
import { getParser, getPostgresPlpgsqlParser } from '../grammars';
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
 * Routine bodies are opaque leaves in the outer grammar. Static dollar-quoted
 * SQL bodies are reparsed with PostgreSQL; PL/pgSQL and DO blocks are first
 * parsed with the pinned companion grammar and only its explicit SQL regions
 * are injected back into PostgreSQL. Dynamic EXECUTE remains deliberately
 * opaque because indexing must never guess or execute generated source.
 */

interface SqlName {
  parts: string[];
  qualified: string;
  simple: string;
}

type ReferenceKind = 'references' | 'calls' | PostgresObjectReferenceKind;

const NAME_SEGMENT_TYPES = new Set(['ColId', 'ColLabel', 'type_function_name']);

// GenericType also covers built-ins such as text/jsonb/uuid. Filter the core
// catalog spellings so typed object references stay useful instead of adding a
// failed unresolved row for nearly every column in a schema dump.
const POSTGRES_BUILTIN_TYPES = new Set([
  'aclitem', 'any', 'anyarray', 'anycompatible', 'anycompatiblearray', 'anycompatiblenonarray',
  'anycompatiblemultirange', 'anycompatiblerange', 'anyelement', 'anyenum',
  'anymultirange', 'anynonarray', 'anyrange', 'bigint', 'bigserial', 'bit', 'bool',
  'boolean', 'box', 'bpchar', 'bytea', 'char', 'character', 'cidr', 'circle', 'cstring',
  'date', 'datemultirange', 'daterange', 'decimal', 'double precision', 'event_trigger',
  'fdw_handler', 'float4', 'float8', 'gtsvector', 'index_am_handler', 'inet', 'int',
  'int2', 'int2vector', 'int4', 'int4multirange', 'int4range', 'int8', 'int8multirange',
  'int8range', 'integer', 'internal', 'interval', 'json', 'jsonb', 'language_handler',
  'line', 'lseg', 'macaddr', 'macaddr8', 'money', 'name', 'numeric', 'nummultirange',
  'numrange', 'oid', 'oidvector', 'opaque', 'path', 'pg_dependencies', 'pg_lsn',
  'pg_mcv_list', 'pg_ndistinct', 'pg_node_tree', 'pg_snapshot', 'point', 'polygon',
  'real', 'record', 'refcursor', 'regclass', 'regcollation', 'regconfig', 'regdictionary',
  'regnamespace', 'regoper', 'regoperator', 'regproc', 'regprocedure', 'regrole',
  'regtype', 'serial', 'serial2', 'serial4', 'serial8', 'smallint', 'smallserial',
  'table_am_handler', 'text', 'tid', 'time', 'timestamp', 'timestamptz', 'timetz',
  'trigger', 'tsm_handler', 'tsmultirange', 'tsquery', 'tsrange', 'tstzmultirange',
  'tstzrange', 'tsvector', 'txid_snapshot', 'unknown', 'uuid', 'varbit', 'varchar',
  'void', 'xid', 'xid8', 'xml',
]);

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

function postgresDollarTagAt(source: string, offset: number): string | null {
  if (source[offset] !== '$') return null;
  let end = offset + 1;
  if (source[end] === '$') return '$$';
  if (!/[A-Za-z_]/.test(source[end] ?? '')) return null;
  end++;
  while (/[A-Za-z0-9_]/.test(source[end] ?? '')) end++;
  return source[end] === '$' ? source.slice(offset, end + 1) : null;
}

function isPostgresEscapeStringStart(source: string, quoteOffset: number): boolean {
  const prefixOffset = quoteOffset - 1;
  const prefix = source[prefixOffset];
  if (prefix !== 'E' && prefix !== 'e') return false;
  // E/e is a literal prefix only at a token boundary, not the tail of an
  // identifier such as `some' text'`.
  return prefixOffset === 0 || !/[A-Za-z0-9_$]/.test(source[prefixOffset - 1] ?? '');
}

function postgresCodeMask(source: string): string {
  // split('') retains UTF-16 code-unit indexes; a code-point spread would make
  // every replacement after an astral character address the wrong position.
  const masked = source.split('');
  let single = false;
  let singleBackslashEscapes = false;
  let double = false;
  let dollarTag: string | null = null;
  let lineComment = false;
  let blockDepth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char !== '\n') masked[index] = ' ';
      else lineComment = false;
      continue;
    }
    if (blockDepth > 0) {
      if (char !== '\n') masked[index] = ' ';
      if (char === '/' && next === '*') {
        masked[++index] = ' ';
        blockDepth++;
      } else if (char === '*' && next === '/') {
        masked[++index] = ' ';
        blockDepth--;
      }
      continue;
    }
    if (dollarTag) {
      if (char !== '\n') masked[index] = ' ';
      if (source.startsWith(dollarTag, index)) {
        for (let cursor = index; cursor < index + dollarTag.length; cursor++) masked[cursor] = ' ';
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (single) {
      if (char !== '\n') masked[index] = ' ';
      if (char === "'" && next === "'") masked[++index] = ' ';
      else if (char === "'") {
        single = false;
        singleBackslashEscapes = false;
      } else if (
        singleBackslashEscapes && char === '\\' && index + 1 < source.length
      ) masked[++index] = ' ';
      continue;
    }
    if (double) {
      if (char !== '\n') masked[index] = ' ';
      if (char === '"' && next === '"') masked[++index] = ' ';
      else if (char === '"') double = false;
      continue;
    }
    if (char === '-' && next === '-') {
      masked[index] = masked[index + 1] = ' ';
      lineComment = true;
      index++;
    } else if (char === '/' && next === '*') {
      masked[index] = masked[index + 1] = ' ';
      blockDepth = 1;
      index++;
    } else if (char === "'") {
      masked[index] = ' ';
      single = true;
      singleBackslashEscapes = isPostgresEscapeStringStart(source, index);
    } else if (char === '"') {
      masked[index] = ' ';
      double = true;
    } else if (char === '$') {
      const tag = postgresDollarTagAt(source, index);
      if (tag) {
        for (let cursor = index; cursor < index + tag.length; cursor++) masked[cursor] = ' ';
        dollarTag = tag;
        index += tag.length - 1;
      }
    }
  }
  return masked.join('');
}

/** Match COPY's top-level direction without mistaking a query's inner FROM. */
function isCopyFromStdinStatement(statement: string): boolean {
  const copy = /^\s*COPY\b/i.exec(statement);
  if (!copy) return false;
  let depth = 0;
  for (let index = copy[0].length; index < statement.length;) {
    const char = statement[index]!;
    if (char === '(') {
      depth++;
      index++;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      index++;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      const start = index++;
      while (/[A-Za-z0-9_$]/.test(statement[index] ?? '')) index++;
      const word = statement.slice(start, index).toUpperCase();
      if (word === 'TO') return false;
      if (word === 'FROM') {
        while (/\s/.test(statement[index] ?? '')) index++;
        const source = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(statement.slice(index))?.[0];
        return source?.toUpperCase() === 'STDIN';
      }
      continue;
    }
    index++;
  }
  return false;
}

/**
 * Offset-preserving PostgreSQL dialect cleanup for constructs intentionally
 * outside the core server grammar:
 *
 * - psql meta-command lines are blanked;
 * - psql variables become equivalent parser-safe expressions;
 * - a valid CHECK-expression shape that gmr/tree-sitter-postgres currently
 *   mis-parses receives redundant parentheses in place of existing spaces.
 *
 * Every replacement is ASCII-for-ASCII and retains every newline, so the AST
 * still addresses the original file's byte offsets and source locations.
 */
export function preParsePostgresSource(source: string): string {
  const output = source.split('');
  const psqlCopyPayloadStarts: number[] = [];
  let single = false;
  let singleBackslashEscapes = false;
  let double = false;
  let dollarTag: string | null = null;
  let lineComment = false;
  let blockDepth = 0;
  let atLineStart = true;

  for (let index = 0; index < source.length; index++) {
    if (atLineStart) {
      atLineStart = false;
      if (!single && !double && !dollarTag && blockDepth === 0 && !lineComment) {
        let commandStart = index;
        while (source[commandStart] === ' ' || source[commandStart] === '\t') commandStart++;
        if (source[commandStart] === '\\') {
          const lineEnd = source.indexOf('\n', commandStart);
          const end = lineEnd < 0 ? source.length : lineEnd;
          const command = source.slice(commandStart, end).replace(/\r$/, '');
          const copyStatement = `${command.slice(1).replace(/;?\s*$/, '')};`;
          if (isCopyFromStdinStatement(copyStatement) && lineEnd >= 0) {
            psqlCopyPayloadStarts.push(lineEnd + 1);
          }
          for (let cursor = commandStart; cursor < end; cursor++) output[cursor] = ' ';
          index = end - 1;
          continue;
        }
      }
    }

    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        atLineStart = true;
      }
      continue;
    }
    if (blockDepth > 0) {
      if (char === '/' && next === '*') {
        blockDepth++;
        index++;
      } else if (char === '*' && next === '/') {
        blockDepth--;
        index++;
      } else if (char === '\n') {
        atLineStart = true;
      }
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = null;
      } else if (char === '\n') {
        atLineStart = true;
      }
      continue;
    }
    if (single) {
      if (char === "'" && next === "'") {
        index++;
      } else if (char === "'") {
        single = false;
        singleBackslashEscapes = false;
      } else if (
        singleBackslashEscapes && char === '\\' && index + 1 < source.length
      ) {
        index++;
      } else if (char === '\n') {
        atLineStart = true;
      }
      continue;
    }
    if (double) {
      if (char === '"' && next === '"') {
        index++;
      } else if (char === '"') {
        double = false;
      } else if (char === '\n') {
        atLineStart = true;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      lineComment = true;
      index++;
    } else if (char === '/' && next === '*') {
      blockDepth = 1;
      index++;
    } else if (char === "'") {
      single = true;
      singleBackslashEscapes = isPostgresEscapeStringStart(source, index);
    } else if (char === '"') {
      double = true;
    } else if (char === '$') {
      const tag = postgresDollarTagAt(source, index);
      if (tag) {
        dollarTag = tag;
        index += tag.length - 1;
      }
    } else if (char === ':' && source[index - 1] !== ':' && (next === "'" || next === '"')) {
      // `:'name'` / `:"name"`: removing only the psql interpolation marker
      // leaves a valid string literal / quoted identifier of identical length.
      output[index] = ' ';
    } else if (char === ':' && source[index - 1] !== ':' && /[A-Za-z_]/.test(next ?? '')) {
      let end = index + 2;
      while (/[A-Za-z0-9_]/.test(source[end] ?? '')) end++;
      output[index] = '$';
      output[index + 1] = '1';
      for (let cursor = index + 2; cursor < end; cursor++) output[cursor] = ' ';
      index = end - 1;
    } else if (char === '\n') {
      atLineStart = true;
    }
  }

  // gmr parses a server COPY statement itself but intentionally does not
  // consume psql's following text-format payload. psql's `\copy` uses the same
  // payload protocol but normally has no semicolon and its command line was
  // blanked above. Only erase a payload when an exact `\.` terminator exists;
  // without one, subsequent SQL must remain visible instead of being silently
  // treated as data. Every erased byte keeps its original newline/offset.
  const blankCopyPayload = (firstDataOffset: number): number | null => {
    let lineStart = firstDataOffset;
    let terminatorEnd: number | null = null;
    while (lineStart < source.length) {
      const newline = source.indexOf('\n', lineStart);
      const lineEnd = newline < 0 ? source.length : newline;
      const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');
      if (line === '\\.') {
        terminatorEnd = lineEnd;
        break;
      }
      if (newline < 0) break;
      lineStart = newline + 1;
    }
    if (terminatorEnd === null) return null;
    for (let cursor = firstDataOffset; cursor < terminatorEnd; cursor++) {
      if (source[cursor] !== '\n') output[cursor] = ' ';
    }
    const newline = source.indexOf('\n', terminatorEnd);
    return newline < 0 ? source.length : newline + 1;
  };

  for (const firstDataOffset of psqlCopyPayloadStarts) {
    blankCopyPayload(firstDataOffset);
  }

  // Inspect complete semicolon-delimited statements rather than searching for
  // the words COPY/FROM/STDIN anywhere. This keeps valid identifiers in e.g.
  // `SELECT copy FROM stdin` from erasing every later line in the file.
  const preparedCode = postgresCodeMask(output.join(''));
  let statementStart = 0;
  for (let cursor = 0; cursor < preparedCode.length; cursor++) {
    if (preparedCode[cursor] !== ';') continue;
    const statement = preparedCode.slice(statementStart, cursor + 1);
    const isCopyFromStdin = isCopyFromStdinStatement(statement);
    if (isCopyFromStdin) {
      const headerLineEnd = source.indexOf('\n', cursor + 1);
      const resume = headerLineEnd < 0 ? null : blankCopyPayload(headerLineEnd + 1);
      if (resume !== null) {
        cursor = resume - 1;
        statementStart = resume;
        continue;
      }
    }
    statementStart = cursor + 1;
  }

  const checkPattern = /(\bCHECK)(\s+)\(([^;\n]*?\bIN\s*\([^()\n]*\))(\s+)=/gi;
  const code = postgresCodeMask(output.join(''));
  for (let match = checkPattern.exec(code); match; match = checkPattern.exec(code)) {
    const afterKeyword = match.index + (match[1]?.length ?? 0);
    const beforeEquals = match.index + match[0].length - 1 - (match[4]?.length ?? 0);
    output[afterKeyword] = '(';
    output[beforeEquals] = ')';
  }
  return output.join('');
}

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

function directChildren(node: SyntaxNode, ...types: string[]): SyntaxNode[] {
  return children(node).filter((child) => types.includes(child.type));
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

function isUserDefinedPostgresType(name: SqlName): boolean {
  if (name.parts.length > 1) {
    return name.parts[0] !== 'pg_catalog' && name.parts[0] !== 'information_schema';
  }
  return !POSTGRES_BUILTIN_TYPES.has(name.simple.toLowerCase());
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
    state = analyzePostgresSearchPath(ctx.source, { copyPayloadsMasked: true });
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
      searchPathState(ctx),
      true
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
  addReferenceAt(ctx, fromNodeId, target, kind, {
    startIndex: positionNode.startIndex,
    line: positionNode.startPosition.row + 1,
    column: positionNode.startPosition.column,
  });
}

function addReferenceAt(
  ctx: ExtractorContext,
  fromNodeId: string,
  target: SqlName,
  kind: ReferenceKind,
  position: { startIndex: number; line: number; column: number },
  searchPathCandidates?: readonly string[]
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
    position.startIndex
  );
  const temporaryBinding = visibleTemporaryCandidates(
    ctx,
    target,
    position.startIndex
  ).map((candidate) => candidate.id).sort().join('\u001f');
  const key = `${fromNodeId}\u0000${kind}\u0000${target.qualified}` +
    `\u0000${activePath.explicit ? 'explicit' : 'default'}` +
    `\u0000${activePath.schemas.join('\u001f')}` +
    `\u0000routine:${searchPathCandidates === undefined
      ? 'ambient'
      : searchPathCandidates.join('\u001f')}` +
    `\u0000temp:${temporaryBinding}`;
  if (keys.has(key)) return;
  keys.add(key);

  const reference = {
    fromNodeId,
    referenceName: target.qualified,
    referenceKind: kind,
    line: position.line,
    column: position.column,
    ...(searchPathCandidates === undefined
      ? {}
      : { candidates: [...searchPathCandidates] }),
  };
  ctx.addUnresolvedReference(reference);
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

function addDecorators(created: Node | null | undefined, ...decorators: string[]): void {
  if (!created) return;
  const merged = new Set(created.decorators ?? []);
  for (const decorator of decorators) merged.add(decorator);
  created.decorators = [...merged];
}

function walkChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of children(node)) ctx.visitNode(child);
}

function createColumn(
  ctx: ExtractorContext,
  node: SyntaxNode,
  nameNode: SyntaxNode,
  parentQualifiedOverride?: string
): Node | null {
  const name = readSqlName(nameNode, ctx.source);
  if (!name) return null;
  const parentQualified = parentQualifiedOverride ?? currentScopeQualifiedName(ctx);
  const qualifiedName = parentQualified
    ? appendPostgresIdentifier(parentQualified, name.simple)
    : name.qualified;
  const idDiscriminator = `${qualifiedName}@${node.startPosition.row + 1}:` +
    `${node.startPosition.column + 1}`;
  const created = ctx.createNode('field', idDiscriminator, node, {
    name: name.simple,
    qualifiedName,
    signature: compactText(node, ctx.source, 200),
    decorators: ['postgres:column'],
    isExported: true,
  });
  const typeNode = directChild(node, 'Typename');
  const typeName = readSqlName(typeNode, ctx.source);
  if (created && typeNode && typeName && isUserDefinedPostgresType(typeName)) {
    addReference(
      ctx,
      created.id,
      typeName,
      POSTGRES_TYPE_REFERENCE_KIND,
      typeNode
    );
  }
  if (created) createStaticSequenceReferences(node, ctx, created.id);
  return created;
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

function createRoutineBodyReferences(
  node: SyntaxNode,
  ctx: ExtractorContext,
  ownerId: string
): void {
  const postgres = getParser('postgres');
  if (!postgres) return;
  const discovery = discoverPostgresRoutineBodyReferences(node, ctx.source, {
    postgres,
    plpgsql: getPostgresPlpgsqlParser(),
  });
  if (discovery.status !== 'analyzed') return;
  for (const fact of discovery.facts) {
    addReferenceAt(
      ctx,
      ownerId,
      sqlNameFromParts(fact.parts),
      fact.kind === 'sequence' ? POSTGRES_SEQUENCE_REFERENCE_KIND : fact.kind,
      fact,
      fact.searchPathCandidates
    );
  }
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
  withCreatedScope(ctx, created, () => {
    walkChildren(node, ctx);
    if (created) createRoutineBodyReferences(node, ctx, created.id);
  });
  return true;
}

function createDoBlock(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const identity = `DO@${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
  const created = ctx.createNode('function', identity, node, {
    name: 'DO block',
    qualifiedName: `${ctx.filePath}::${identity}`,
    signature: 'DO block',
    decorators: ['postgres:do-block'],
    isExported: false,
  });
  withCreatedScope(ctx, created, () => {
    walkChildren(node, ctx);
    if (created) createRoutineBodyReferences(node, ctx, created.id);
  });
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
  if (node.type === 'AlterPolicyStmt') addDecorators(created, 'postgres:alter-policy');
  withCreatedScope(ctx, created, () => {
    if (created && tableNode && tableName) {
      addReference(ctx, created.id, tableName, 'references', tableNode);
    }
    walkChildren(node, ctx);
  });
  return true;
}

function renamedName(previous: SqlName, replacement: SqlName): SqlName {
  return sqlNameFromParts([...previous.parts.slice(0, -1), replacement.simple]);
}

function createDrop(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const objectType = directChild(node, 'object_type_any_name');
  if (!objectType) return false;
  let relationKind: PostgresDroppedRelationKind | null = null;
  if (hasDirectChild(objectType, 'kw_table')) {
    relationKind = hasDirectChild(objectType, 'kw_foreign') ? 'foreign-table' : 'table';
  } else if (hasDirectChild(objectType, 'kw_view')) {
    relationKind = hasDirectChild(objectType, 'kw_materialized')
      ? 'materialized-view'
      : 'view';
  }
  if (!relationKind) return false;

  const objectLabel = relationKind.replace('-', ' ').toUpperCase();
  for (const nameNode of allDescendants(node, 'any_name')) {
    const rawName = readSqlName(nameNode, ctx.source);
    const name = rawName ? nameInSearchPathSchema(rawName, node, ctx) : null;
    if (!name) continue;
    const displayName = `DROP ${objectLabel} ${name.qualified}`;
    const created = ctx.createNode('constant', `${displayName}@${node.startIndex}`, node, {
      name: displayName,
      qualifiedName: appendPostgresIdentifier(name.qualified, displayName),
      signature: compactText(node, ctx.source),
      decorators: [
        POSTGRES_DROP_RELATION_DECORATOR,
        encodePostgresDropRelationDescriptor({
          relationName: name.qualified,
          relationKind,
        }),
      ],
      isExported: true,
    });
    if (created) addReference(ctx, created.id, name, 'references', nameNode);
  }
  return true;
}

function createRename(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const replacementNodes = directChildren(node, 'name');

  if (hasDirectChild(node, 'kw_policy')) {
    const tableNode = directChild(node, 'qualified_name');
    const rawTable = readSqlName(tableNode, ctx.source);
    const table = rawTable ? nameInSearchPathSchema(rawTable, node, ctx) : null;
    const replacement = readSqlName(replacementNodes[replacementNodes.length - 1] ?? null, ctx.source);
    if (!tableNode || !table || !replacement) return true;
    const qualified = appendPostgresIdentifier(table.qualified, replacement.simple);
    const created = createDatabaseNode(
      ctx,
      node,
      replacement,
      'constant',
      'policy',
      qualified
    );
    addDecorators(created, 'postgres:renamed-policy');
    if (created) addReference(ctx, created.id, table, 'references', tableNode);
    return true;
  }

  const relation = directChild(node, 'relation_expr');
  const tableNode = relation ? firstDescendant(relation, 'qualified_name') : null;
  const rawTable = readSqlName(tableNode, ctx.source);
  const table = rawTable ? nameInSearchPathSchema(rawTable, node, ctx) : null;

  if (relation && tableNode && table && hasDirectChild(node, 'opt_column')) {
    const names = replacementNodes.map((candidate) => readSqlName(candidate, ctx.source));
    const previous = names[0];
    const replacement = names[names.length - 1];
    if (!previous || !replacement) return true;
    const qualifiedName = appendPostgresIdentifier(table.qualified, replacement.simple);
    const idDiscriminator = `${qualifiedName}@${node.startPosition.row + 1}:` +
      `${node.startPosition.column + 1}`;
    const created = ctx.createNode('field', idDiscriminator, node, {
      name: replacement.simple,
      qualifiedName,
      signature: compactText(node, ctx.source),
      decorators: ['postgres:column', 'postgres:renamed-column'],
      isExported: true,
    });
    if (created) addReference(ctx, created.id, table, 'references', tableNode);
    return true;
  }

  if (relation && tableNode && table && hasDirectChild(node, 'kw_constraint')) {
    const names = replacementNodes.map((candidate) => readSqlName(candidate, ctx.source));
    const previous = names[0];
    const replacement = names[names.length - 1];
    if (!previous || !replacement) return true;
    const qualifiedName = appendPostgresIdentifier(table.qualified, replacement.simple);
    const created = createDatabaseNode(
      ctx,
      node,
      replacement,
      'constant',
      'constraint',
      qualifiedName
    );
    addDecorators(
      created,
      'postgres:renamed-constraint',
      POSTGRES_RENAME_CONSTRAINT_DECORATOR,
      encodePostgresRenameConstraintDescriptor({
        table: table.qualified,
        sourceConstraint: previous.simple,
        targetConstraint: replacement.simple,
      })
    );
    if (created) addReference(ctx, created.id, table, 'references', tableNode);
    return true;
  }

  if (relation && tableNode && table && hasDirectChild(node, 'kw_table')) {
    const replacement = readSqlName(replacementNodes[replacementNodes.length - 1] ?? null, ctx.source);
    if (!replacement) return true;
    const next = renamedName(table, replacement);
    const created = createDatabaseNode(ctx, node, next, 'struct', 'table');
    addDecorators(created, 'postgres:renamed-relation');
    markTemporary(created, isTemporaryRelationName(table));
    if (created) addReference(ctx, created.id, table, 'references', tableNode);
    createTableRelationFact(
      ctx,
      node,
      table,
      next,
      'rename' as PostgresTableRelationKind,
      tableNode,
      replacementNodes[replacementNodes.length - 1] ?? node
    );
    return true;
  }

  const sourceNode = directChild(node, 'qualified_name', 'any_name');
  const rawSource = readSqlName(sourceNode, ctx.source);
  const source = rawSource ? nameInSearchPathSchema(rawSource, node, ctx) : null;
  const replacement = readSqlName(replacementNodes[replacementNodes.length - 1] ?? null, ctx.source);
  if (!sourceNode || !source || !replacement) return true;
  const next = renamedName(source, replacement);

  if (hasDirectChild(node, 'kw_view')) {
    const objectKind = hasDirectChild(node, 'kw_materialized')
      ? 'materialized-view'
      : 'view';
    const created = createDatabaseNode(ctx, node, next, 'struct', objectKind);
    addDecorators(created, 'postgres:renamed-relation');
    markTemporary(created, isTemporaryRelationName(source));
    if (created) addReference(ctx, created.id, source, 'references', sourceNode);
    createTableRelationFact(
      ctx,
      node,
      source,
      next,
      'rename' as PostgresTableRelationKind,
      sourceNode,
      replacementNodes[replacementNodes.length - 1] ?? node
    );
    return true;
  }

  if (hasDirectChild(node, 'kw_type') && !hasDirectChild(node, 'kw_attribute')) {
    const created = createDatabaseNode(ctx, node, next, 'type_alias', 'type');
    addDecorators(
      created,
      'postgres:renamed-type',
      POSTGRES_TYPE_RENAME_DECORATOR,
      encodePostgresTypeRenameDescriptor({
        sourceType: source.qualified,
        targetType: next.qualified,
      })
    );
    if (created) {
      addReference(ctx, created.id, source, POSTGRES_TYPE_REFERENCE_KIND, sourceNode);
    }
    return true;
  }

  const objectKind = hasDirectChild(node, 'kw_index')
    ? 'index'
    : hasDirectChild(node, 'kw_sequence')
      ? 'sequence'
      : 'type';
  const kind: NodeKind = objectKind === 'index'
    ? 'constant'
    : objectKind === 'sequence'
      ? 'variable'
      : 'type_alias';
  const created = createDatabaseNode(ctx, node, next, kind, objectKind);
  addDecorators(created, `postgres:renamed-${objectKind}`);
  return true;
}

function postgresStringLiteral(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  const raw = getNodeText(node, source);
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw || null;
}

function createAlterEnum(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const typeNode = directChild(node, 'any_name');
  const rawType = readSqlName(typeNode, ctx.source);
  const typeName = rawType ? nameInSearchPathSchema(rawType, node, ctx) : null;
  const values = directChildren(node, 'Sconst')
    .map((value) => firstDescendant(value, 'string_literal'))
    .filter((value): value is SyntaxNode => value !== null);
  const renamed = hasDirectChild(node, 'kw_rename');
  const sourceValueNode = renamed ? values[0] ?? null : null;
  const valueNode = renamed ? values[values.length - 1] ?? null : values[0] ?? null;
  const sourceValue = postgresStringLiteral(sourceValueNode, ctx.source);
  const value = postgresStringLiteral(valueNode, ctx.source);
  if (!typeName || !valueNode || !value || (renamed && !sourceValue)) return true;
  const qualifiedName = appendPostgresIdentifier(typeName.qualified, value);
  const idDiscriminator = `${qualifiedName}@${valueNode.startPosition.row + 1}:` +
    `${valueNode.startPosition.column + 1}`;
  ctx.createNode('enum_member', idDiscriminator, valueNode, {
    name: value,
    qualifiedName,
    signature: compactText(node, ctx.source),
    decorators: [
      'postgres:enum-value',
      renamed ? 'postgres:renamed-enum-value' : 'postgres:alter-enum-add-value',
      POSTGRES_ENUM_VALUE_MUTATION_DECORATOR,
      encodePostgresEnumValueMutationDescriptor(renamed ? {
        mutation: 'rename',
        enumType: typeName.qualified,
        sourceValue: sourceValue!,
        targetValue: value,
      } : {
        mutation: 'add',
        enumType: typeName.qualified,
        targetValue: value,
      }),
    ],
    isExported: true,
  });
  return true;
}

function createAlterSequence(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const sequenceNode = directChild(node, 'qualified_name');
  const rawSequence = readSqlName(sequenceNode, ctx.source);
  const sequence = rawSequence ? nameInSearchPathSchema(rawSequence, node, ctx) : null;
  const ownerNode = firstDescendant(node, 'any_name');
  const owner = readSqlName(ownerNode, ctx.source);
  if (!sequence || !ownerNode || !owner || owner.parts.length < 2) return true;
  const table = sqlNameFromParts(owner.parts.slice(0, -1));
  const identity = `OWNED BY ${owner.qualified}`;
  const deltaName: SqlName = {
    parts: [...sequence.parts, identity],
    qualified: appendPostgresIdentifier(sequence.qualified, identity),
    simple: sequence.simple,
  };
  const created = createDatabaseNode(
    ctx,
    node,
    deltaName,
    'constant',
    'sequence-ownership'
  );
  if (created) {
    addReference(ctx, created.id, table, 'references', ownerNode);
    if (sequenceNode) {
      addReference(
        ctx,
        created.id,
        sequence,
        POSTGRES_SEQUENCE_REFERENCE_KIND,
        sequenceNode
      );
    }
  }
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

function createConstraint(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const references = directChild(node, 'kw_references');
  if (references && (node.type === 'ColConstraintElem' || hasDirectChild(node, 'kw_foreign'))) {
    return createForeignKey(node, ctx);
  }

  const constraintKind = hasDirectChild(node, 'kw_primary')
    ? 'primary-key'
    : hasDirectChild(node, 'kw_unique')
      ? 'unique'
      : hasDirectChild(node, 'kw_check')
        ? 'check'
        : null;
  if (!constraintKind) {
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
  const columns = node.type === 'ConstraintElem'
    ? columnNames(directChild(node, 'columnList'), ctx.source)
    : (() => {
        const column = nearestAncestor(node, 'columnDef');
        const name = readSqlName(column ? directChild(column, 'ColId') : null, ctx.source);
        return name ? [name.simple] : [];
      })();
  const label = constraintName?.simple ?? `${constraintKind.toUpperCase()} (${columns.join(', ')})`;
  const identity = constraintName?.simple ??
    `${label} @${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
  const qualifiedName = appendPostgresIdentifier(sourceTable.qualified, identity);
  const idDiscriminator = `${qualifiedName}@${node.startPosition.row + 1}:` +
    `${node.startPosition.column + 1}`;
  const created = ctx.createNode('constant', idDiscriminator, wrapper ?? node, {
    name: label,
    qualifiedName,
    signature: compactText(wrapper ?? node, ctx.source),
    decorators: ['postgres:constraint', `postgres:${constraintKind}`],
    isExported: true,
  });
  withCreatedScope(ctx, created, () => {
    if (created) {
      addReference(ctx, created.id, sourceTable, 'references', alterTableNode ?? node);
    }
    walkChildren(node, ctx);
  });
  return true;
}

function createDropConstraint(
  command: SyntaxNode,
  ctx: ExtractorContext,
  tableName: SqlName,
  tableNode: SyntaxNode
): boolean {
  if (!hasDirectChild(command, 'kw_drop') || !hasDirectChild(command, 'kw_constraint')) {
    return false;
  }
  const constraintNode = directChild(command, 'name');
  const constraint = readSqlName(constraintNode, ctx.source);
  if (!constraintNode || !constraint) return false;
  const identity = `DROP CONSTRAINT ${constraint.simple}`;
  const qualifiedName = appendPostgresIdentifier(tableName.qualified, identity);
  const idDiscriminator = `${qualifiedName}@${command.startPosition.row + 1}:` +
    `${command.startPosition.column + 1}`;
  const created = ctx.createNode('constant', idDiscriminator, command, {
    name: identity,
    qualifiedName,
    signature: compactText(command, ctx.source),
    decorators: [
      POSTGRES_DROP_CONSTRAINT_DECORATOR,
      encodePostgresDropConstraintDescriptor({
        table: tableName.qualified,
        constraintName: constraint.simple,
      }),
    ],
    isExported: true,
  });
  if (created) addReference(ctx, created.id, tableName, 'references', tableNode);
  return true;
}

function createIdentitySequence(
  command: SyntaxNode,
  ctx: ExtractorContext,
  tableName: SqlName,
  tableNode: SyntaxNode
): void {
  const identity = firstDescendant(command, 'kw_identity');
  if (!identity) return;
  const sequenceNode = allDescendants(command, 'any_name')
    .find((candidate) => candidate.startIndex > identity.startIndex) ?? null;
  const rawSequence = readSqlName(sequenceNode, ctx.source);
  const sequence = rawSequence ? nameInSearchPathSchema(rawSequence, command, ctx) : null;
  if (!sequenceNode || !sequence) return;
  const created = createDatabaseNode(ctx, command, sequence, 'variable', 'sequence');
  addDecorators(created, 'postgres:identity-sequence');
  if (created) addReference(ctx, created.id, tableName, 'references', tableNode);
}

function createAlterColumnType(
  command: SyntaxNode,
  ctx: ExtractorContext,
  tableName: SqlName,
  tableNode: SyntaxNode
): boolean {
  const typeNode = directChild(command, 'Typename');
  const typeName = readSqlName(typeNode, ctx.source);
  const columnNode = directChild(command, 'ColId');
  const columnName = readSqlName(columnNode, ctx.source);
  if (!typeNode || !typeName || !columnName || !isUserDefinedPostgresType(typeName)) return false;
  const identity = `ALTER COLUMN ${columnName.simple} TYPE ${typeName.qualified}`;
  const qualifiedName = appendPostgresIdentifier(tableName.qualified, identity);
  const idDiscriminator = `${qualifiedName}@${command.startPosition.row + 1}:` +
    `${command.startPosition.column + 1}`;
  const created = ctx.createNode('constant', idDiscriminator, command, {
    name: identity,
    qualifiedName,
    signature: compactText(command, ctx.source),
    decorators: ['postgres:alter-table-column-type'],
    isExported: true,
  });
  withCreatedScope(ctx, created, () => {
    if (!created) return;
    addReference(ctx, created.id, tableName, 'references', tableNode);
    addReference(ctx, created.id, typeName, POSTGRES_TYPE_REFERENCE_KIND, typeNode);
    walkChildren(command, ctx);
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
    createIdentitySequence(command, ctx, tableName, tableNode);
    if (createDropConstraint(command, ctx, tableName, tableNode)) {
      walkChildren(command, ctx);
      continue;
    }
    if (createAlterColumnType(command, ctx, tableName, tableNode)) continue;
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

function createStaticSequenceReferences(
  container: SyntaxNode,
  ctx: ExtractorContext,
  ownerId: string
): void {
  const applications = container.type === 'func_application'
    ? [container]
    : allDescendants(container, 'func_application');
  for (const application of applications) {
    const functionName = readSqlName(directChild(application, 'func_name'), ctx.source);
    if (!functionName || !['nextval', 'currval', 'setval'].includes(functionName.simple)) continue;
    const literal = postgresStaticSequenceLiteral(application);
    const rawSequence = postgresStringLiteral(literal, ctx.source);
    const parts = rawSequence ? parsePostgresQualifiedName(rawSequence) : null;
    if (!literal || !parts || parts.length === 0) continue;
    addReference(
      ctx,
      ownerId,
      sqlNameFromParts(parts),
      POSTGRES_SEQUENCE_REFERENCE_KIND,
      literal
    );
  }
}

function emitTypeReference(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (nearestAncestor(node, 'columnDef', 'alter_table_cmd')) return true;
  const name = readSqlName(node, ctx.source);
  const ownerId = currentScopeId(ctx);
  if (name && ownerId && isUserDefinedPostgresType(name)) {
    addReference(ctx, ownerId, name, POSTGRES_TYPE_REFERENCE_KIND, node);
  }
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
    if (!nearestAncestor(node, 'columnDef')) {
      createStaticSequenceReferences(node, ctx, fromNodeId);
    }
  }
  walkChildren(node, ctx);
  return true;
}

export const postgresExtractor: LanguageExtractor = {
  preParse: preParsePostgresSource,
  reportParseErrors: true,
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

      case 'DoStmt':
        return createDoBlock(node, ctx);

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
      case 'AlterPolicyStmt':
        return createPolicy(node, ctx);

      case 'RenameStmt':
        return createRename(node, ctx);

      case 'DropStmt':
        return createDrop(node, ctx);

      case 'AlterEnumStmt':
        return createAlterEnum(node, ctx);

      case 'IndexStmt':
        return createIndex(node, ctx);

      case 'CreateSeqStmt':
        return createSequence(node, ctx);

      case 'AlterSeqStmt':
        return createAlterSequence(node, ctx);

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
        return createConstraint(node, ctx);

      case 'Typename':
        return emitTypeReference(node, ctx);

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
