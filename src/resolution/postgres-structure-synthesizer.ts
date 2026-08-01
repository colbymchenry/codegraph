import { createHash } from 'node:crypto';
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import {
  parsePostgresQualifiedName,
  serializePostgresQualifiedName,
  isPostgresQualifiedName,
} from '../postgres/identifiers';
import {
  POSTGRES_TABLE_RELATION_DECORATOR,
  decodePostgresTableRelationDescriptor,
  type PostgresTableRelationDescriptor,
} from '../postgres/table-relation';
import type { MaybeYield } from './cooperative-yield';

export const POSTGRES_STRUCTURE_SYNTHESIZER = 'postgres-structure';
const POSTGRES_STRUCTURE_FINGERPRINT_METADATA = 'postgres_structure_state_fingerprint';

interface ResolvedEndpoint {
  node: Node;
  refName: string | undefined;
}

interface RelationFact extends PostgresTableRelationDescriptor {
  filePath: string;
  line: number;
  column: number;
}

const SCHEMA_OBJECT_DECORATORS = new Set([
  'postgres:table',
  'postgres:foreign-table',
  'postgres:view',
  'postgres:materialized-view',
  'postgres:function',
  'postgres:procedure',
  'postgres:type',
  'postgres:enum',
  'postgres:domain',
  'postgres:sequence',
  'postgres:index',
]);

function isTable(node: Node | null): node is Node {
  return node?.language === 'postgres' && node.kind === 'struct' && (
    node.decorators?.includes('postgres:table') === true ||
    node.decorators?.includes('postgres:foreign-table') === true
  );
}

function resolvedEndpoint(endpoints: ResolvedEndpoint[], name: string): Node | null {
  let matches = endpoints
    .filter((endpoint) => endpoint.refName === name)
    .map((endpoint) => endpoint.node);
  if (matches.length === 0) {
    const qualified = isPostgresQualifiedName(name);
    const parsed = parsePostgresQualifiedName(name);
    const simple = parsed?.[parsed.length - 1] ?? name;
    matches = endpoints
      .map((endpoint) => endpoint.node)
      .filter((node) => qualified ? node.qualifiedName === name : node.name === simple);
  }
  const unique = new Map(matches.map((node) => [node.id, node]));
  return unique.size === 1 ? unique.values().next().value ?? null : null;
}

function relationEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  for (const factNode of queries.iterateNodesByLanguageWithDecorator(
    'postgres',
    POSTGRES_TABLE_RELATION_DECORATOR
  )) {
    const descriptor = decodePostgresTableRelationDescriptor(factNode.decorators);
    if (!descriptor) continue;
    const endpoints = queries
      .getOutgoingEdges(factNode.id, ['references'])
      .map((edge) => ({
        node: queries.getNodeById(edge.target),
        refName: typeof edge.metadata?.refName === 'string' ? edge.metadata.refName : undefined,
      }))
      .filter((endpoint): endpoint is ResolvedEndpoint => isTable(endpoint.node));
    const source = resolvedEndpoint(endpoints, descriptor.sourceTable);
    const target = resolvedEndpoint(endpoints, descriptor.targetTable);
    if (!source || !target) continue;
    const fact: RelationFact = {
      ...descriptor,
      filePath: factNode.filePath,
      line: factNode.startLine,
      column: factNode.startColumn,
    };
    edges.push({
      source: source.id,
      target: target.id,
      kind: 'references',
      line: factNode.startLine,
      column: factNode.startColumn,
      provenance: 'tree-sitter',
      metadata: {
        synthesizedBy: POSTGRES_STRUCTURE_SYNTHESIZER,
        postgresRelation: descriptor.relation,
        facts: [fact],
      },
    });
  }
  return edges;
}

function isSchemaObject(node: Node): boolean {
  return node.decorators?.some((decorator) => SCHEMA_OBJECT_DECORATORS.has(decorator)) === true &&
    node.decorators?.includes('postgres:temporary') !== true;
}

function schemaContainmentEdges(queries: QueryBuilder): Edge[] {
  const schemas = new Map<string, Node[]>();
  const nativeContainment = new Map<string, Set<string>>();
  for (const node of queries.iterateNodesByLanguage('postgres')) {
    if (node.kind !== 'namespace' || node.decorators?.includes('postgres:schema') !== true) continue;
    const existing = schemas.get(node.qualifiedName);
    if (existing) existing.push(node);
    else schemas.set(node.qualifiedName, [node]);
  }

  const edges: Edge[] = [];
  for (const object of queries.iterateNodesByLanguage('postgres')) {
    if (!isSchemaObject(object)) continue;
    const parts = parsePostgresQualifiedName(object.qualifiedName);
    if (!parts || parts.length < 2 || parts[0] === 'pg_temp') continue;
    const schemaName = serializePostgresQualifiedName([parts[0]!]);
    const candidates = schemas.get(schemaName) ?? [];
    const sameFile = candidates.filter((schema) => schema.filePath === object.filePath);
    const schema = sameFile.length === 1
      ? sameFile[0]
      : sameFile.length === 0 && candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!schema) continue;
    let nativeTargets = nativeContainment.get(schema.id);
    if (!nativeTargets) {
      nativeTargets = new Set(
        queries.getOutgoingEdges(schema.id, ['contains'])
          .filter((edge) => edge.metadata?.synthesizedBy !== POSTGRES_STRUCTURE_SYNTHESIZER)
          .map((edge) => edge.target)
      );
      nativeContainment.set(schema.id, nativeTargets);
    }
    if (nativeTargets.has(object.id)) continue;
    edges.push({
      source: schema.id,
      target: object.id,
      kind: 'contains',
      line: object.startLine,
      column: object.startColumn,
      provenance: 'tree-sitter',
      metadata: {
        synthesizedBy: POSTGRES_STRUCTURE_SYNTHESIZER,
        postgresRelation: 'schema-containment',
      },
    });
  }
  return edges;
}

function materializePostgresStructureEdges(queries: QueryBuilder): Edge[] {
  return [...relationEdges(queries), ...schemaContainmentEdges(queries)];
}

function structureInputFingerprint(
  queries: QueryBuilder
): { fingerprint: string; inputCount: number } {
  const hash = createHash('sha256');
  let inputCount = 0;
  let previousFact: string | null = null;
  for (const row of queries.iterateDecoratorReferenceState(
    'postgres',
    POSTGRES_TABLE_RELATION_DECORATOR
  )) {
    if (row.nodeId !== previousFact) {
      inputCount++;
      previousFact = row.nodeId;
    }
    hash.update(JSON.stringify(['fact', row]));
    hash.update('\n');
  }
  for (const node of queries.iterateNodesByLanguage('postgres')) {
    if (node.kind !== 'namespace' && !isSchemaObject(node)) continue;
    inputCount++;
    hash.update(JSON.stringify([
      'node', node.id, node.kind, node.qualifiedName, node.filePath, node.decorators,
    ]));
    hash.update('\n');
    if (node.kind === 'namespace') {
      for (const edge of queries.getOutgoingEdges(node.id, ['contains'])) {
        if (edge.metadata?.synthesizedBy === POSTGRES_STRUCTURE_SYNTHESIZER) continue;
        hash.update(JSON.stringify([
          'native-containment', edge.source, edge.target, edge.line, edge.column,
        ]));
        hash.update('\n');
      }
    }
  }
  return { fingerprint: `v1:${hash.digest('hex')}`, inputCount };
}

function structureOutputFingerprint(
  queries: QueryBuilder
): { fingerprint: string; edgeCount: number } {
  const hash = createHash('sha256');
  let edgeCount = 0;
  for (const edge of queries.iterateEdgesBySynthesizer(POSTGRES_STRUCTURE_SYNTHESIZER)) {
    edgeCount++;
    hash.update(JSON.stringify(edge));
    hash.update('\n');
  }
  return { fingerprint: `v1:${hash.digest('hex')}`, edgeCount };
}

function persistedFingerprint(input: string, output: string): string {
  return `input=${input};output=${output}`;
}

function persistFingerprint(
  queries: QueryBuilder,
  input: { fingerprint: string; inputCount: number }
): void {
  const output = structureOutputFingerprint(queries);
  if (input.inputCount === 0 && output.edgeCount === 0) {
    queries.deleteMetadata(POSTGRES_STRUCTURE_FINGERPRINT_METADATA);
  } else {
    queries.setMetadata(
      POSTGRES_STRUCTURE_FINGERPRINT_METADATA,
      persistedFingerprint(input.fingerprint, output.fingerprint)
    );
  }
}

export async function refreshPostgresStructureEdges(
  queries: QueryBuilder,
  onYield: MaybeYield
): Promise<number> {
  const input = structureInputFingerprint(queries);
  const output = structureOutputFingerprint(queries);
  const previous = queries.getMetadata(POSTGRES_STRUCTURE_FINGERPRINT_METADATA);
  if (input.inputCount === 0 && output.edgeCount === 0 && previous === null) return 0;
  if (previous === persistedFingerprint(input.fingerprint, output.fingerprint)) return 0;
  const edges = materializePostgresStructureEdges(queries);
  await onYield();
  queries.replaceEdgesBySynthesizer(POSTGRES_STRUCTURE_SYNTHESIZER, edges);
  persistFingerprint(queries, input);
  return edges.length;
}

export function refreshPostgresStructureEdgesSync(queries: QueryBuilder): number {
  const input = structureInputFingerprint(queries);
  const output = structureOutputFingerprint(queries);
  const previous = queries.getMetadata(POSTGRES_STRUCTURE_FINGERPRINT_METADATA);
  if (input.inputCount === 0 && output.edgeCount === 0 && previous === null) return 0;
  if (previous === persistedFingerprint(input.fingerprint, output.fingerprint)) return 0;
  const edges = materializePostgresStructureEdges(queries);
  queries.replaceEdgesBySynthesizer(POSTGRES_STRUCTURE_SYNTHESIZER, edges);
  persistFingerprint(queries, input);
  return edges.length;
}
