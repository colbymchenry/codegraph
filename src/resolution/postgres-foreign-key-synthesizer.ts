import { createHash } from 'node:crypto';
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import {
  POSTGRES_FOREIGN_KEY_DECORATOR,
  decodePostgresForeignKeyDescriptor,
  type PostgresForeignKeyDescriptor,
} from '../postgres/foreign-key';
import { isPostgresQualifiedName } from '../postgres/identifiers';
import type { MaybeYield } from './cooperative-yield';

export const POSTGRES_FOREIGN_KEY_SYNTHESIZER = 'postgres-foreign-key';
export const POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA =
  'postgres_foreign_key_state_fingerprint';

interface ConstraintFact extends PostgresForeignKeyDescriptor {
  filePath: string;
  line: number;
}

interface ForeignKeyGroup {
  source: Node;
  target: Node;
  constraints: ConstraintFact[];
  line: number;
}

function isTable(node: Node | null): node is Node {
  return node?.language === 'postgres' && node.kind === 'struct' && (
    node.decorators?.includes('postgres:table') === true ||
    node.decorators?.includes('postgres:foreign-table') === true
  );
}

interface ResolvedEndpoint {
  node: Node;
  refName: string | undefined;
}

function resolvedEndpoint(
  endpoints: ResolvedEndpoint[],
  name: string
): Node | null {
  // `refName` preserves which of the FK fact's two references produced an
  // edge. Node-name matching alone cannot distinguish `audit.users` (source)
  // from an unqualified `users` target resolved through search_path.
  let matches = endpoints
    .filter((endpoint) => endpoint.refName === name)
    .map((endpoint) => endpoint.node);
  if (matches.length === 0) {
    const qualified = isPostgresQualifiedName(name);
    matches = endpoints
      .map((endpoint) => endpoint.node)
      .filter((node) => qualified ? node.qualifiedName === name : node.name === name);
  }
  const unique = new Map(matches.map((node) => [node.id, node]));
  return unique.size === 1 ? unique.values().next().value ?? null : null;
}

/**
 * Convert resolved constraint endpoints into the relationship users expect to
 * traverse: source table -> referenced table. Several constraints between the
 * same pair are aggregated on one edge rather than multiplying graph paths.
 */
function collectForeignKey(
  grouped: Map<string, ForeignKeyGroup>,
  queries: QueryBuilder,
  foreignKey: Node
): void {
  if (!foreignKey.decorators?.includes(POSTGRES_FOREIGN_KEY_DECORATOR)) return;
  const descriptor = decodePostgresForeignKeyDescriptor(foreignKey.decorators);
  if (!descriptor) return;

  const endpoints = queries
    .getOutgoingEdges(foreignKey.id, ['references'])
    .map((edge) => ({
      node: queries.getNodeById(edge.target),
      refName: typeof edge.metadata?.refName === 'string' ? edge.metadata.refName : undefined,
    }))
    .filter((endpoint): endpoint is ResolvedEndpoint => isTable(endpoint.node));
  const source = resolvedEndpoint(endpoints, descriptor.sourceTable);
  const target = resolvedEndpoint(endpoints, descriptor.targetTable);
  if (!source || !target) return;

  const key = `${source.id}\u0000${target.id}`;
  const fact: ConstraintFact = {
    ...descriptor,
    filePath: foreignKey.filePath,
    line: foreignKey.startLine,
  };
  const existing = grouped.get(key);
  if (existing) {
    existing.constraints.push(fact);
    existing.line = Math.min(existing.line, foreignKey.startLine);
  } else {
    grouped.set(key, {
      source,
      target,
      constraints: [fact],
      line: foreignKey.startLine,
    });
  }
}

function materializeForeignKeyEdges(grouped: Map<string, ForeignKeyGroup>): Edge[] {
  return [...grouped.values()].map(({ source, target, constraints, line }) => ({
    source: source.id,
    target: target.id,
    kind: 'references',
    line,
    provenance: 'tree-sitter',
    metadata: {
      synthesizedBy: POSTGRES_FOREIGN_KEY_SYNTHESIZER,
      postgresRelation: 'foreign-key',
      constraints: constraints.sort((a, b) =>
        a.filePath.localeCompare(b.filePath) || a.line - b.line
      ),
    },
  }));
}

function postgresForeignKeyStateFingerprint(
  queries: QueryBuilder
): { fingerprint: string; factCount: number } {
  const hash = createHash('sha256');
  let factCount = 0;
  let previousNodeId: string | null = null;
  for (const row of queries.iterateDecoratorReferenceState(
    'postgres',
    POSTGRES_FOREIGN_KEY_DECORATOR
  )) {
    if (row.nodeId !== previousNodeId) {
      factCount++;
      previousNodeId = row.nodeId;
    }
    hash.update(JSON.stringify([
      row.nodeId,
      row.decorators,
      row.targetId,
      row.edgeMetadata,
      row.targetQualifiedName,
      row.targetKind,
      row.targetLanguage,
      row.targetDecorators,
    ]));
    hash.update('\n');
  }
  return { fingerprint: `v2:${hash.digest('hex')}`, factCount };
}

function postgresForeignKeyOutputFingerprint(
  queries: QueryBuilder
): { fingerprint: string; edgeCount: number } {
  const hash = createHash('sha256');
  let edgeCount = 0;
  for (const edge of queries.iterateEdgesBySynthesizer(POSTGRES_FOREIGN_KEY_SYNTHESIZER)) {
    edgeCount++;
    hash.update(JSON.stringify([
      edge.source,
      edge.target,
      edge.kind,
      edge.metadata,
      edge.line,
      edge.col,
      edge.provenance,
    ]));
    hash.update('\n');
  }
  return { fingerprint: `v1:${hash.digest('hex')}`, edgeCount };
}

function persistedFingerprint(input: string, output: string): string {
  return `input=${input};output=${output}`;
}

function persistCurrentFingerprint(
  queries: QueryBuilder,
  input: { fingerprint: string; factCount: number }
): void {
  const output = postgresForeignKeyOutputFingerprint(queries);
  if (input.factCount === 0 && output.edgeCount === 0) {
    queries.deleteMetadata(POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA);
  } else {
    queries.setMetadata(
      POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA,
      persistedFingerprint(input.fingerprint, output.fingerprint)
    );
  }
}

export function postgresForeignKeyEdgesSync(queries: QueryBuilder): Edge[] {
  const grouped = new Map<string, ForeignKeyGroup>();
  for (const foreignKey of queries.iterateNodesByLanguageWithDecorator(
    'postgres',
    POSTGRES_FOREIGN_KEY_DECORATOR
  )) {
    collectForeignKey(grouped, queries, foreignKey);
  }
  return materializeForeignKeyEdges(grouped);
}

export async function postgresForeignKeyEdges(
  queries: QueryBuilder,
  onYield: MaybeYield
): Promise<Edge[]> {
  const grouped = new Map<string, ForeignKeyGroup>();
  let scanned = 0;
  for (const foreignKey of queries.iterateNodesByLanguageWithDecorator(
    'postgres',
    POSTGRES_FOREIGN_KEY_DECORATOR
  )) {
    if ((++scanned & 127) === 0) await onYield();
    collectForeignKey(grouped, queries, foreignKey);
  }

  return materializeForeignKeyEdges(grouped);
}

/** Atomically refresh the owned edge set after facts are resolved. */
export async function refreshPostgresForeignKeyEdges(
  queries: QueryBuilder,
  onYield: MaybeYield
): Promise<number> {
  const state = postgresForeignKeyStateFingerprint(queries);
  const output = postgresForeignKeyOutputFingerprint(queries);
  const previous = queries.getMetadata(POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA);
  if (state.factCount === 0 && output.edgeCount === 0 && previous === null) return 0;
  if (previous === persistedFingerprint(state.fingerprint, output.fingerprint)) return 0;

  // Compute first so a parser/query failure leaves the last complete edge set.
  const edges = await postgresForeignKeyEdges(queries, onYield);
  queries.replaceEdgesBySynthesizer(POSTGRES_FOREIGN_KEY_SYNTHESIZER, edges);
  persistCurrentFingerprint(queries, state);
  await onYield();
  return edges.length;
}

/** Synchronous counterpart for the public synchronous resolution API. */
export function refreshPostgresForeignKeyEdgesSync(queries: QueryBuilder): number {
  const state = postgresForeignKeyStateFingerprint(queries);
  const output = postgresForeignKeyOutputFingerprint(queries);
  const previous = queries.getMetadata(POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA);
  if (state.factCount === 0 && output.edgeCount === 0 && previous === null) return 0;
  if (previous === persistedFingerprint(state.fingerprint, output.fingerprint)) return 0;

  const edges = postgresForeignKeyEdgesSync(queries);
  queries.replaceEdgesBySynthesizer(POSTGRES_FOREIGN_KEY_SYNTHESIZER, edges);
  persistCurrentFingerprint(queries, state);
  return edges.length;
}
