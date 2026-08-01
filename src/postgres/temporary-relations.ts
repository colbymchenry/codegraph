import type { Node } from '../types';
import { parsePostgresQualifiedName } from './identifiers';
import {
  postgresOffsetAtPosition,
  postgresTopLevelStatements,
  type PostgresSearchPathState,
} from './search-path';

interface VisibilityChange {
  offset: number;
  visible: boolean;
}

export interface PostgresTemporaryRelationVisibilityState {
  changesByNodeId: Map<string, VisibilityChange[]>;
}

interface TemporaryDeclaration {
  node: Node;
  endOffset: number;
  onCommitDrop: boolean;
}

interface TemporarySavepoint {
  name: string;
  visible: Map<string, boolean>;
}

function dollarTagAt(source: string, offset: number): string | null {
  if (source[offset] !== '$') return null;
  let end = offset + 1;
  if (source[end] === '$') return '$$';
  if (!/[A-Za-z_]/.test(source[end] ?? '')) return null;
  end++;
  while (/[A-Za-z0-9_]/.test(source[end] ?? '')) end++;
  return source[end] === '$' ? source.slice(offset, end + 1) : null;
}

/** Match a real ON COMMIT DROP clause, not the same words in a literal. */
function hasOnCommitDrop(source: string): boolean {
  let searchable = '';
  let single = false;
  let double = false;
  let dollarTag: string | null = null;
  let lineComment = false;
  let blockDepth = 0;

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      searchable += char === '\n' ? '\n' : ' ';
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockDepth > 0) {
      searchable += char === '\n' ? '\n' : ' ';
      if (char === '/' && next === '*') {
        searchable += ' ';
        blockDepth++;
        index++;
      } else if (char === '*' && next === '/') {
        searchable += ' ';
        blockDepth--;
        index++;
      }
      continue;
    }
    if (dollarTag) {
      searchable += ' ';
      if (source.startsWith(dollarTag, index)) {
        searchable += ' '.repeat(dollarTag.length - 1);
        index += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (single) {
      searchable += ' ';
      if (char === "'" && next === "'") {
        searchable += ' ';
        index++;
      } else if (char === "'") {
        single = false;
      } else if (char === '\\' && index + 1 < source.length) {
        searchable += ' ';
        index++;
      }
      continue;
    }
    if (double) {
      searchable += ' ';
      if (char === '"' && next === '"') {
        searchable += ' ';
        index++;
      } else if (char === '"') {
        double = false;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      searchable += '  ';
      lineComment = true;
      index++;
    } else if (char === '/' && next === '*') {
      searchable += '  ';
      blockDepth = 1;
      index++;
    } else if (char === "'") {
      searchable += ' ';
      single = true;
    } else if (char === '"') {
      searchable += ' ';
      double = true;
    } else if (char === '$') {
      const tag = dollarTagAt(source, index);
      if (tag) {
        searchable += ' '.repeat(tag.length);
        dollarTag = tag;
        index += tag.length - 1;
      } else {
        searchable += char;
      }
    } else {
      searchable += char;
    }
  }

  return /\bON\s+COMMIT\s+DROP\b/i.test(searchable);
}

function splitDropTargets(raw: string): string[] {
  const result: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === '"') {
      current += char;
      if (quoted && raw[index + 1] === '"') {
        current += raw[++index]!;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function temporaryDropKind(node: Node): string | null {
  if (node.decorators?.includes('postgres:table')) return 'table';
  if (node.decorators?.includes('postgres:view')) return 'view';
  if (node.decorators?.includes('postgres:sequence')) return 'sequence';
  return null;
}

function dropTargets(statement: string): { kind: string; names: string[][] } | null {
  const match = /^\s*DROP\s+(TABLE|VIEW|SEQUENCE)\s+(?:IF\s+EXISTS\s+)?([\s\S]*?)\s*;\s*$/i
    .exec(statement);
  if (!match) return null;
  const body = (match[2] ?? '').replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '');
  const names = splitDropTargets(body)
    .map((target) => parsePostgresQualifiedName(target))
    .filter((parts): parts is string[] => parts !== null);
  return { kind: (match[1] ?? '').toLowerCase(), names };
}

function dropMatches(node: Node, drop: { kind: string; names: string[][] }): boolean {
  if (temporaryDropKind(node) !== drop.kind) return false;
  const candidate = parsePostgresQualifiedName(node.qualifiedName);
  if (!candidate || candidate.length < 2) return false;
  const simple = candidate[candidate.length - 1]!;
  return drop.names.some((target) => {
    if (target.length === 1) return target[0] === simple;
    if (target.length !== candidate.length) return false;
    const targetSchema = target[0];
    const candidateSchema = candidate[0];
    const sameTemporarySchema = targetSchema === 'pg_temp' &&
      (candidateSchema === 'pg_temp' || /^pg_temp_[0-9]+$/.test(candidateSchema ?? ''));
    return (sameTemporarySchema || targetSchema === candidateSchema) &&
      target.slice(1).every((part, index) => part === candidate[index + 1]);
  });
}

function isBegin(statement: string): boolean {
  return /^\s*(?:BEGIN|START\s+TRANSACTION)\b[\s\S]*;\s*$/i.test(statement);
}

function isCommit(statement: string): boolean {
  return /^\s*(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?(?:\s+AND\s+(?:NO\s+)?CHAIN)?\s*;\s*$/i
    .test(statement);
}

function isRollback(statement: string): boolean {
  return /^\s*ROLLBACK(?:\s+(?:WORK|TRANSACTION))?(?:\s+AND\s+(?:NO\s+)?CHAIN)?\s*;\s*$/i
    .test(statement);
}

function chains(statement: string): boolean {
  return /\bAND\s+CHAIN\s*;\s*$/i.test(statement);
}

function decodeSavepointName(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value.toLowerCase();
}

function findSavepointIndex(savepoints: TemporarySavepoint[], name: string): number {
  for (let index = savepoints.length - 1; index >= 0; index--) {
    if (savepoints[index]!.name === name) return index;
  }
  return -1;
}

/**
 * Build statement-ordered visibility timelines for temporary relations in one
 * SQL file. Effects become visible at statement completion. Transactional
 * CREATE/DROP is restored by ROLLBACK, while ON COMMIT DROP is applied only by
 * an actual or implicit commit.
 */
export function analyzePostgresTemporaryRelationVisibility(
  source: string,
  nodes: readonly Node[],
  positions: PostgresSearchPathState
): PostgresTemporaryRelationVisibilityState {
  const declarations: TemporaryDeclaration[] = nodes
    .filter((node) => node.language === 'postgres' &&
      node.decorators?.includes('postgres:temporary') === true)
    .map((node) => {
      const startOffset = postgresOffsetAtPosition(
        positions,
        node.startLine,
        node.startColumn
      );
      const endOffset = postgresOffsetAtPosition(positions, node.endLine, node.endColumn);
      return {
        node,
        endOffset,
        onCommitDrop: hasOnCommitDrop(source.slice(startOffset, endOffset)),
      };
    })
    .sort((left, right) => left.endOffset - right.endOffset ||
      left.node.id.localeCompare(right.node.id));

  const changesByNodeId = new Map<string, VisibilityChange[]>();
  const visible = new Map<string, boolean>();
  let transactionSnapshot: Map<string, boolean> | null = null;
  let savepoints: TemporarySavepoint[] = [];
  let declarationIndex = 0;

  const record = (declaration: TemporaryDeclaration, value: boolean, offset: number): void => {
    const previous = visible.get(declaration.node.id) ?? false;
    if (previous === value) return;
    visible.set(declaration.node.id, value);
    let changes = changesByNodeId.get(declaration.node.id);
    if (!changes) {
      changes = [];
      changesByNodeId.set(declaration.node.id, changes);
    }
    changes.push({ offset, visible: value });
  };

  const snapshot = (): Map<string, boolean> => new Map(visible);
  const restore = (state: Map<string, boolean>, offset: number): void => {
    for (const declaration of declarations) {
      record(declaration, state.get(declaration.node.id) ?? false, offset);
    }
  };

  const declareThrough = (endOffset: number): void => {
    while (declarationIndex < declarations.length &&
      declarations[declarationIndex]!.endOffset <= endOffset) {
      const declaration = declarations[declarationIndex++]!;
      if (transactionSnapshot) {
        record(declaration, true, endOffset);
      } else if (!declaration.onCommitDrop) {
        record(declaration, true, endOffset);
      }
    }
  };

  for (const statement of postgresTopLevelStatements(source)) {
    const text = statement.text;
    const savepoint = /^\s*SAVEPOINT\s+("(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)\s*;\s*$/i
      .exec(text);
    const rollbackTo = /^\s*ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO(?:\s+SAVEPOINT)?\s+("(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)\s*;\s*$/i
      .exec(text);
    const release = /^\s*RELEASE(?:\s+SAVEPOINT)?\s+("(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)\s*;\s*$/i
      .exec(text);
    if (isBegin(text)) {
      if (!transactionSnapshot) {
        transactionSnapshot = snapshot();
        savepoints = [];
      }
    } else if (isCommit(text)) {
      for (const declaration of declarations) {
        if (declaration.onCommitDrop && visible.get(declaration.node.id) === true) {
          record(declaration, false, statement.endOffset);
        }
      }
      savepoints = [];
      transactionSnapshot = chains(text) ? snapshot() : null;
    } else if (rollbackTo) {
      const name = decodeSavepointName(rollbackTo[1] ?? '');
      const index = findSavepointIndex(savepoints, name);
      if (index >= 0) {
        restore(savepoints[index]!.visible, statement.endOffset);
        // The target remains active; later savepoints are destroyed.
        savepoints.length = index + 1;
      }
    } else if (isRollback(text)) {
      if (transactionSnapshot) restore(transactionSnapshot, statement.endOffset);
      savepoints = [];
      transactionSnapshot = chains(text) ? snapshot() : null;
    } else if (savepoint) {
      if (transactionSnapshot) {
        savepoints.push({
          name: decodeSavepointName(savepoint[1] ?? ''),
          visible: snapshot(),
        });
      }
    } else if (release) {
      const name = decodeSavepointName(release[1] ?? '');
      const index = findSavepointIndex(savepoints, name);
      if (index >= 0) savepoints.length = index;
    } else {
      const drop = dropTargets(text);
      if (drop) {
        for (const declaration of declarations) {
          if (visible.get(declaration.node.id) === true && dropMatches(declaration.node, drop)) {
            record(declaration, false, statement.endOffset);
          }
        }
      }
    }
    declareThrough(statement.endOffset);
  }

  // A final statement does not require a semicolon. Its declarations become
  // visible at EOF under the same implicit-transaction rule. The node range is
  // also a fallback when a minimal ResolutionContext cannot provide source.
  declareThrough(Math.max(source.length, declarations.at(-1)?.endOffset ?? 0));
  return { changesByNodeId };
}

export function postgresTemporaryRelationVisibleAt(
  state: PostgresTemporaryRelationVisibilityState,
  nodeId: string,
  offset: number
): boolean {
  const changes = state.changesByNodeId.get(nodeId);
  if (!changes) return false;
  let low = 0;
  let high = changes.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (changes[middle]!.offset <= offset) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found >= 0 && changes[found]!.visible;
}
