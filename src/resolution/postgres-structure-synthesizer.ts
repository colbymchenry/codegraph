import { createHash } from 'node:crypto';
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import {
  parsePostgresQualifiedName,
  serializePostgresQualifiedName,
} from '../postgres/identifiers';
import {
  POSTGRES_TABLE_RELATION_DECORATOR,
  decodePostgresTableRelationDescriptor,
  type PostgresTableRelationDescriptor,
} from '../postgres/table-relation';
import { POSTGRES_DROP_RELATION_DECORATOR } from '../postgres/relation-lifecycle';
import type { MaybeYield } from './cooperative-yield';
import { postgresEnumLifecycleEdges } from './postgres-enum-lifecycle';
import { PostgresRelationLifecycle } from './postgres-relation-lifecycle';
import {
  PostgresTableRenameTimeline,
  comparePostgresMigrationPosition,
  isPostgresMigrationPositionLater,
  isPostgresRelation,
  isPostgresTable,
  type PostgresMigrationPosition,
  type PostgresResolvedTableEndpoint,
} from './postgres-rename-timeline';

export const POSTGRES_STRUCTURE_SYNTHESIZER = 'postgres-structure';
const POSTGRES_STRUCTURE_FINGERPRINT_METADATA = 'postgres_structure_state_fingerprint';

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

function relationEdges(
  queries: QueryBuilder,
  renames: PostgresTableRenameTimeline,
  lifecycle: PostgresRelationLifecycle
): Edge[] {
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
      .filter((endpoint): endpoint is PostgresResolvedTableEndpoint =>
        descriptor.relation === 'rename'
          ? isPostgresRelation(endpoint.node)
          : isPostgresTable(endpoint.node)
      );
    const position: PostgresMigrationPosition = {
      filePath: factNode.filePath,
      line: factNode.startLine,
      column: factNode.startColumn,
    };
    if (
      descriptor.relation !== 'rename' && (
        lifecycle.isDroppedAfter(descriptor.sourceTable, position) ||
        lifecycle.isDroppedAfter(descriptor.targetTable, position)
      )
    ) continue;
    // A rename edge records the immediate transition. All other structural
    // facts are projected through rename statements that occur after them.
    const source = descriptor.relation === 'rename'
      ? lifecycle.renameSourceEndpoint(endpoints, descriptor.sourceTable, position)
      : lifecycle.canonicalTableEndpoint(endpoints, descriptor.sourceTable, position);
    const target = descriptor.relation === 'rename'
      ? renames.immediateRelationEndpoint(endpoints, descriptor.targetTable)
      : lifecycle.canonicalTableEndpoint(endpoints, descriptor.targetTable, position);
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

function isEnum(node: Node): boolean {
  return node.language === 'postgres' && node.kind === 'enum' &&
    node.decorators?.includes('postgres:enum') === true;
}

function isEnumMember(node: Node): boolean {
  return node.language === 'postgres' && node.kind === 'enum_member' &&
    node.decorators?.includes('postgres:enum-value') === true;
}

function nativeContainmentTargets(
  queries: QueryBuilder,
  cache: Map<string, Set<string>>,
  parent: Node
): Set<string> {
  let targets = cache.get(parent.id);
  if (!targets) {
    targets = new Set(
      queries.getOutgoingEdges(parent.id, ['contains'])
        .filter((edge) => edge.metadata?.synthesizedBy !== POSTGRES_STRUCTURE_SYNTHESIZER)
        .map((edge) => edge.target)
    );
    cache.set(parent.id, targets);
  }
  return targets;
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
    const nativeTargets = nativeContainmentTargets(queries, nativeContainment, schema);
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

function enumContainmentEdges(queries: QueryBuilder): Edge[] {
  const enums = new Map<string, Node[]>();
  const nativeContainment = new Map<string, Set<string>>();
  for (const node of queries.iterateNodesByLanguage('postgres')) {
    if (!isEnum(node)) continue;
    const existing = enums.get(node.qualifiedName);
    if (existing) existing.push(node);
    else enums.set(node.qualifiedName, [node]);
  }

  const edges: Edge[] = [];
  for (const member of queries.iterateNodesByLanguage('postgres')) {
    if (!isEnumMember(member)) continue;
    const parts = parsePostgresQualifiedName(member.qualifiedName);
    if (!parts || parts.length < 2) continue;
    const parentName = serializePostgresQualifiedName(parts.slice(0, -1));
    const candidates = enums.get(parentName) ?? [];
    const memberPosition: PostgresMigrationPosition = {
      filePath: member.filePath,
      line: member.startLine,
      column: member.startColumn,
    };
    // ALTER TYPE values belong to the most recent preceding declaration in
    // the same migration stream. This disambiguates a later DROP/re-CREATE of
    // the same enum without attaching an older value to that future version.
    const preceding = candidates
      .filter((candidate) => isPostgresMigrationPositionLater(memberPosition, {
        filePath: candidate.filePath,
        line: candidate.startLine,
        column: candidate.startColumn,
      }))
      .sort((left, right) => comparePostgresMigrationPosition({
        filePath: right.filePath,
        line: right.startLine,
        column: right.startColumn,
      }, {
        filePath: left.filePath,
        line: left.startLine,
        column: left.startColumn,
      }));
    const latest = preceding[0];
    const latestPosition = latest && {
      filePath: latest.filePath,
      line: latest.startLine,
      column: latest.startColumn,
    };
    const latestCandidates = latestPosition
      ? preceding.filter((candidate) => comparePostgresMigrationPosition({
        filePath: candidate.filePath,
        line: candidate.startLine,
        column: candidate.startColumn,
      }, latestPosition) === 0)
      : [];
    const sameFile = candidates.filter((candidate) => candidate.filePath === member.filePath);
    const parent = latestCandidates.length === 1
      ? latestCandidates[0]
      : preceding.length === 0 && sameFile.length === 1
        ? sameFile[0]
        : preceding.length === 0 && sameFile.length === 0 && candidates.length === 1
          ? candidates[0]
          : undefined;
    if (!parent) continue;
    if (nativeContainmentTargets(queries, nativeContainment, parent).has(member.id)) continue;
    edges.push({
      source: parent.id,
      target: member.id,
      kind: 'contains',
      line: member.startLine,
      column: member.startColumn,
      provenance: 'tree-sitter',
      metadata: {
        synthesizedBy: POSTGRES_STRUCTURE_SYNTHESIZER,
        postgresRelation: 'enum-containment',
      },
    });
  }
  return edges;
}

function materializePostgresStructureEdges(queries: QueryBuilder): Edge[] {
  const renames = new PostgresTableRenameTimeline(queries);
  const lifecycle = new PostgresRelationLifecycle(queries, renames);
  return [
    ...relationEdges(queries, renames, lifecycle),
    ...schemaContainmentEdges(queries),
    ...enumContainmentEdges(queries),
    ...postgresEnumLifecycleEdges(queries),
  ];
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
  for (const row of queries.iterateDecoratorReferenceState(
    'postgres',
    POSTGRES_DROP_RELATION_DECORATOR
  )) {
    inputCount++;
    hash.update(JSON.stringify(['drop-relation', row]));
    hash.update('\n');
  }
  for (const node of queries.iterateNodesByLanguage('postgres')) {
    if (node.kind !== 'namespace' && !isSchemaObject(node) && !isEnumMember(node)) continue;
    inputCount++;
    hash.update(JSON.stringify([
      'node', node.id, node.kind, node.qualifiedName, node.filePath, node.decorators,
    ]));
    hash.update('\n');
    if (node.kind === 'namespace' || isEnum(node)) {
      for (const edge of queries.getOutgoingEdges(node.id, ['contains'])) {
        if (edge.metadata?.synthesizedBy === POSTGRES_STRUCTURE_SYNTHESIZER) continue;
        hash.update(JSON.stringify([
          'native-containment', edge.source, edge.target, edge.line, edge.column,
        ]));
        hash.update('\n');
      }
    }
  }
  return { fingerprint: `v3:${hash.digest('hex')}`, inputCount };
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
