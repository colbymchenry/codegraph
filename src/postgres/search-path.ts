/** PostgreSQL search_path parsing shared by extraction and resolution. */

export interface PostgresSearchPath {
  schemas: string[];
  explicit: boolean;
}

export interface PostgresSearchPathChange extends PostgresSearchPath {
  offset: number;
}

export interface PostgresSearchPathState {
  changes: PostgresSearchPathChange[];
  lineStarts: number[];
}

export interface PostgresStatement {
  text: string;
  endOffset: number;
}

export interface PostgresStatementOptions {
  /** COPY payloads and their `\.` terminators were already blanked in-place. */
  copyPayloadsMasked?: boolean;
}

interface PostgresSavepoint {
  name: string;
  session: PostgresSearchPath;
  local: PostgresSearchPath | null;
}

const DEFAULT_PATH: PostgresSearchPath = {
  // PostgreSQL's literal default is "$user", public. Source indexing does not
  // know the runtime role; public is the useful deterministic fallback used by
  // migration tooling, while an explicit $user entry remains a shadow barrier.
  schemas: ['public'],
  explicit: false,
};

function dollarTagAt(source: string, offset: number): string | null {
  if (source[offset] !== '$') return null;
  let end = offset + 1;
  if (source[end] === '$') return '$$';
  if (!/[A-Za-z_]/.test(source[end] ?? '')) return null;
  end++;
  while (/[A-Za-z0-9_]/.test(source[end] ?? '')) end++;
  return source[end] === '$' ? source.slice(offset, end + 1) : null;
}

function clonePath(path: PostgresSearchPath): PostgresSearchPath {
  return { schemas: [...path.schemas], explicit: path.explicit };
}

function cloneOptionalPath(path: PostgresSearchPath | null): PostgresSearchPath | null {
  return path ? clonePath(path) : null;
}

function decodeSavepointName(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value.toLowerCase();
}

function findSavepointIndex(savepoints: PostgresSavepoint[], name: string): number {
  for (let index = savepoints.length - 1; index >= 0; index--) {
    if (savepoints[index]!.name === name) return index;
  }
  return -1;
}

function decodeSingleQuoted(raw: string): string | null {
  const value = raw.trim();
  const prefixLength = /^[eE]'/.test(value) ? 1 : 0;
  if (value[prefixLength] !== "'" || value[value.length - 1] !== "'") return null;
  let decoded = '';
  for (let i = prefixLength + 1; i < value.length - 1; i++) {
    const char = value[i]!;
    if (char === "'" && value[i + 1] === "'") {
      decoded += "'";
      i++;
    } else if (prefixLength === 1 && char === '\\' && i + 1 < value.length - 1) {
      decoded += value[++i]!;
    } else {
      decoded += char;
    }
  }
  return decoded;
}

function decodeDollarQuoted(raw: string): string | null {
  const value = raw.trim();
  const opener = dollarTagAt(value, 0);
  if (!opener || !value.endsWith(opener) || value.length < opener.length * 2) return null;
  return value.slice(opener.length, -opener.length);
}

function splitIdentifierList(raw: string, recognizeSingleQuotes: boolean): string[] {
  const parts: string[] = [];
  let current = '';
  let single = false;
  let double = false;
  let dollarTag: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (dollarTag) {
      current += char;
      if (raw.startsWith(dollarTag, i)) {
        current += raw.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (single) {
      current += char;
      if (char === "'" && raw[i + 1] === "'") {
        current += raw[++i]!;
      } else if (char === "'") {
        single = false;
      }
      continue;
    }
    if (double) {
      current += char;
      if (char === '"' && raw[i + 1] === '"') {
        current += raw[++i]!;
      } else if (char === '"') {
        double = false;
      }
      continue;
    }
    if (recognizeSingleQuotes && char === "'") {
      single = true;
      current += char;
    } else if (char === '"') {
      double = true;
      current += char;
    } else if (recognizeSingleQuotes && char === '$') {
      const tag = dollarTagAt(raw, i);
      if (tag) {
        dollarTag = tag;
        current += tag;
        i += tag.length - 1;
      } else {
        current += char;
      }
    } else if (char === ',') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function decodeIdentifier(part: string, setSyntax: boolean): string | null {
  const value = part.trim();
  if (!value) return null;
  if (setSyntax) {
    const single = decodeSingleQuoted(value);
    if (single !== null) return single;
    const dollar = decodeDollarQuoted(value);
    if (dollar !== null) return dollar;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value.toLowerCase();
}

function parseSetSearchPath(raw: string): PostgresSearchPath {
  const trimmed = raw.trim();
  if (/^default$/i.test(trimmed)) return clonePath(DEFAULT_PATH);
  const schemas = splitIdentifierList(trimmed, true)
    .map((part) => decodeIdentifier(part, true))
    .filter((schema): schema is string => schema !== null && schema.length > 0);
  return { schemas, explicit: true };
}

/**
 * Parse the value portion of PostgreSQL's `SET search_path TO/=` syntax.
 *
 * CREATE FUNCTION/PROCEDURE carries the same grammar inside a routine-local
 * configuration clause. Exporting this narrow parser keeps quoted identifiers,
 * string-literal schema names, empty paths, and DEFAULT behavior identical to
 * top-level SET handling without treating the routine option as session state.
 */
export function parsePostgresSearchPathSetting(raw: string): PostgresSearchPath {
  return parseSetSearchPath(raw);
}

function parseGucSearchPath(rawLiteral: string): PostgresSearchPath | null {
  const value = decodeSingleQuoted(rawLiteral) ?? decodeDollarQuoted(rawLiteral);
  if (value === null) return null;
  const schemas = splitIdentifierList(value, false)
    .map((part) => decodeIdentifier(part, false))
    .filter((schema): schema is string => schema !== null && schema.length > 0);
  return { schemas, explicit: true };
}

function parseSetSchema(rawLiteral: string): PostgresSearchPath | null {
  const schema = decodeSingleQuoted(rawLiteral) ?? decodeDollarQuoted(rawLiteral);
  if (schema === null) return null;
  // SET SCHEMA accepts exactly one string literal. In particular, a comma in
  // that literal belongs to the schema name; it is not a search_path separator.
  return { schemas: schema.length > 0 ? [schema] : [], explicit: true };
}

/**
 * Stream top-level statements with bounded buffering. Comments are replaced by
 * spaces, quoted bodies suppress semicolon splitting, and pg_dump COPY payloads
 * are skipped through their standalone `\.` terminator.
 */
export function* postgresTopLevelStatements(
  source: string,
  options: PostgresStatementOptions = {}
): IterableIterator<PostgresStatement> {
  const buffer: string[] = [];
  const MAX_STATEMENT_CHARS = 32_768;
  let blockDepth = 0;
  let lineComment = false;
  let single = false;
  let escapeString = false;
  let double = false;
  let dollarTag: string | null = null;
  let copyPayload = false;
  let statementTail = '';

  const append = (text: string): void => {
    statementTail = (statementTail + text).slice(-512);
    if (buffer.length >= MAX_STATEMENT_CHARS) return;
    const remaining = MAX_STATEMENT_CHARS - buffer.length;
    buffer.push(...text.slice(0, remaining));
  };
  const resetLexicalState = (): void => {
    buffer.length = 0;
    blockDepth = 0;
    lineComment = false;
    single = false;
    escapeString = false;
    double = false;
    dollarTag = null;
    statementTail = '';
  };

  for (let i = 0; i < source.length; i++) {
    if (copyPayload) {
      const newline = source.indexOf('\n', i);
      const lineEnd = newline < 0 ? source.length : newline;
      const line = source.slice(i, lineEnd).replace(/\r$/, '');
      if (line === '\\.') copyPayload = false;
      i = lineEnd;
      resetLexicalState();
      continue;
    }

    const char = source[i]!;
    const next = source[i + 1];
    if (lineComment) {
      append(char === '\n' ? '\n' : ' ');
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockDepth > 0) {
      append(char === '\n' || char === '\r' ? char : ' ');
      if (char === '/' && next === '*') {
        append(' ');
        blockDepth++;
        i++;
      } else if (char === '*' && next === '/') {
        append(' ');
        blockDepth--;
        i++;
      }
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, i)) {
        append(dollarTag);
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        append(char);
      }
      continue;
    }
    if (single) {
      append(char);
      if (char === "'" && next === "'") {
        append(next);
        i++;
      } else if (char === "'") {
        single = false;
        escapeString = false;
      } else if (escapeString && char === '\\' && i + 1 < source.length) {
        append(next ?? '');
        i++;
      }
      continue;
    }
    if (double) {
      append(char);
      if (char === '"' && next === '"') {
        append(next);
        i++;
      } else if (char === '"') {
        double = false;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      append('  ');
      lineComment = true;
      i++;
    } else if (char === '/' && next === '*') {
      append('  ');
      blockDepth = 1;
      i++;
    } else if (char === "'") {
      append(char);
      single = true;
      const prefix = source[i - 1];
      const beforePrefix = source[i - 2];
      escapeString = (prefix === 'E' || prefix === 'e') &&
        (beforePrefix === undefined || !/[A-Za-z0-9_$]/.test(beforePrefix));
    } else if (char === '"') {
      append(char);
      double = true;
    } else if (char === '$' &&
      (i === 0 || !/[A-Za-z0-9_$]/.test(source[i - 1]!))) {
      const tag = dollarTagAt(source, i);
      if (tag) {
        append(tag);
        dollarTag = tag;
        i += tag.length - 1;
      } else {
        append(char);
      }
    } else {
      append(char);
      if (char === ';') {
        const text = buffer.join('');
        copyPayload = options.copyPayloadsMasked !== true &&
          /^\s*COPY\b/i.test(text) &&
          /\bFROM\s+STDIN\s*;\s*$/i.test(statementTail);
        yield { text, endOffset: i + 1 };
        resetLexicalState();
      }
    }
  }
}

function samePath(a: PostgresSearchPath, b: PostgresSearchPath): boolean {
  return a.explicit === b.explicit &&
    a.schemas.length === b.schemas.length &&
    a.schemas.every((schema, index) => schema === b.schemas[index]);
}

export function analyzePostgresSearchPath(
  source: string,
  options: PostgresStatementOptions = {}
): PostgresSearchPathState {
  const changes: PostgresSearchPathChange[] = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }

  let session = clonePath(DEFAULT_PATH);
  let local: PostgresSearchPath | null = null;
  let transactionSnapshot: PostgresSearchPath | null = null;
  let savepoints: PostgresSavepoint[] = [];
  const effective = (): PostgresSearchPath => local ?? session;
  const record = (offset: number, before: PostgresSearchPath): void => {
    const after = effective();
    if (!samePath(before, after)) changes.push({ offset, ...clonePath(after) });
  };

  for (const statement of postgresTopLevelStatements(source, options)) {
    const text = statement.text;
    const before = clonePath(effective());
    const savepoint = /^\s*SAVEPOINT\s+("(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)\s*;\s*$/i
      .exec(text);
    const rollbackTo = /^\s*ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO(?:\s+SAVEPOINT)?\s+("(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)\s*;\s*$/i
      .exec(text);
    const release = /^\s*RELEASE(?:\s+SAVEPOINT)?\s+("(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)\s*;\s*$/i
      .exec(text);
    const commit = /^\s*(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?(?:\s+AND\s+(?:NO\s+)?CHAIN)?\s*;\s*$/i
      .test(text);
    const rollback = /^\s*ROLLBACK(?:\s+(?:WORK|TRANSACTION))?(?:\s+AND\s+(?:NO\s+)?CHAIN)?\s*;\s*$/i
      .test(text);
    const chains = /\bAND\s+CHAIN\s*;\s*$/i.test(text);
    if (/^\s*(?:BEGIN|START\s+TRANSACTION)\b[\s\S]*;\s*$/i.test(text)) {
      if (!transactionSnapshot) {
        transactionSnapshot = clonePath(session);
        savepoints = [];
      }
    } else if (commit) {
      local = null;
      savepoints = [];
      transactionSnapshot = chains ? clonePath(session) : null;
    } else if (rollbackTo) {
      const name = decodeSavepointName(rollbackTo[1] ?? '');
      const index = findSavepointIndex(savepoints, name);
      if (index >= 0) {
        const snapshot = savepoints[index]!;
        session = clonePath(snapshot.session);
        local = cloneOptionalPath(snapshot.local);
        // PostgreSQL keeps the target savepoint active but destroys newer ones.
        savepoints.length = index + 1;
      }
    } else if (rollback) {
      if (transactionSnapshot) session = transactionSnapshot;
      local = null;
      savepoints = [];
      transactionSnapshot = chains ? clonePath(session) : null;
    } else if (savepoint) {
      if (transactionSnapshot) {
        savepoints.push({
          name: decodeSavepointName(savepoint[1] ?? ''),
          session: clonePath(session),
          local: cloneOptionalPath(local),
        });
      }
    } else if (release) {
      const name = decodeSavepointName(release[1] ?? '');
      const index = findSavepointIndex(savepoints, name);
      if (index >= 0) savepoints.length = index;
    } else {
      const set = /^\s*SET\s+(?:(SESSION|LOCAL)\s+)?search_path\s*(?:TO|=)\s*([\s\S]*?)\s*;\s*$/i
        .exec(text);
      const setSchema = /^\s*SET\s+(?:(SESSION|LOCAL)\s+)?SCHEMA\s+((?:[eE])?'(?:''|\\.|[^'])*'|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)\s*;\s*$/i
        .exec(text);
      const reset = /^\s*RESET\s+search_path\s*;\s*$/i.test(text);
      const setConfig = /^\s*SELECT\s+(?:pg_catalog\.)?set_config\s*\(\s*'search_path'\s*,\s*((?:[eE])?'(?:''|\\.|[^'])*'|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)\s*,\s*(true|false)\s*\)\s*;\s*$/i
        .exec(text);

      if (set) {
        const nextPath = parseSetSearchPath(set[2] ?? '');
        if (/^LOCAL$/i.test(set[1] ?? '')) {
          if (transactionSnapshot) local = nextPath;
        } else {
          session = nextPath;
          local = null;
        }
      } else if (setSchema) {
        const nextPath = parseSetSchema(setSchema[2] ?? '');
        if (nextPath) {
          if (/^LOCAL$/i.test(setSchema[1] ?? '')) {
            if (transactionSnapshot) local = nextPath;
          } else {
            session = nextPath;
            local = null;
          }
        }
      } else if (reset) {
        session = clonePath(DEFAULT_PATH);
        local = null;
      } else if (setConfig) {
        const nextPath = parseGucSearchPath(setConfig[1] ?? '');
        if (nextPath) {
          if (/^true$/i.test(setConfig[2] ?? '')) {
            if (transactionSnapshot) local = nextPath;
          } else {
            session = nextPath;
            local = null;
          }
        }
      }
    }
    record(statement.endOffset, before);
  }
  return { changes, lineStarts };
}

export function postgresSearchPathAtOffset(
  state: PostgresSearchPathState,
  offset: number
): PostgresSearchPath {
  let low = 0;
  let high = state.changes.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (state.changes[middle]!.offset <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found >= 0 ? state.changes[found]! : DEFAULT_PATH;
}

export function postgresOffsetAtPosition(
  state: PostgresSearchPathState,
  line: number,
  column: number
): number {
  const lineStart = state.lineStarts[Math.max(0, line - 1)] ??
    state.lineStarts[state.lineStarts.length - 1] ?? 0;
  return lineStart + Math.max(0, column);
}
