import type { QueryBuilder } from '../db/queries';
import {
  decodePostgresEnumValueMutationDescriptor,
  decodePostgresTypeRenameDescriptor,
  type PostgresEnumValueMutationDescriptor,
  type PostgresTypeRenameDescriptor,
} from '../postgres/type-lifecycle';
import type { Edge, Node } from '../types';
import {
  comparePostgresMigrationPosition,
  type PostgresMigrationPosition,
} from './postgres-rename-timeline';

const POSTGRES_STRUCTURE_SYNTHESIZER = 'postgres-structure';

interface EnumState {
  parent: Node;
  members: Map<string, Node>;
}

type EnumLifecycleEvent =
  | {
      kind: 'enum-declaration';
      node: Node;
      position: PostgresMigrationPosition;
    }
  | {
      kind: 'type-declaration';
      node: Node;
      position: PostgresMigrationPosition;
    }
  | {
      kind: 'type-rename';
      node: Node;
      descriptor: PostgresTypeRenameDescriptor;
      position: PostgresMigrationPosition;
    }
  | {
      kind: 'value-mutation';
      node: Node;
      descriptor: PostgresEnumValueMutationDescriptor;
      position: PostgresMigrationPosition;
    };

function migrationStream(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? '' : normalized.slice(0, separator);
}

function position(node: Node): PostgresMigrationPosition {
  return {
    filePath: node.filePath,
    line: node.startLine,
    column: node.startColumn,
  };
}

function eventRank(event: EnumLifecycleEvent): number {
  if (event.kind === 'enum-declaration' || event.kind === 'type-declaration') return 0;
  if (event.kind === 'value-mutation') return 1;
  return 2;
}

function nativeEnumMembers(queries: QueryBuilder, parent: Node): Map<string, Node> {
  const members = new Map<string, Node>();
  for (const edge of queries.getOutgoingEdges(parent.id, ['contains'])) {
    if (edge.metadata?.synthesizedBy === POSTGRES_STRUCTURE_SYNTHESIZER) continue;
    const member = queries.getNodeById(edge.target);
    if (
      member?.language !== 'postgres' ||
      member.kind !== 'enum_member' ||
      member.decorators?.includes('postgres:enum-value') !== true
    ) continue;
    members.set(member.name, member);
  }
  return members;
}

function isEnumDeclaration(node: Node): boolean {
  return node.language === 'postgres' && node.kind === 'enum' &&
    node.decorators?.includes('postgres:enum') === true;
}

function isPlainTypeDeclaration(node: Node): boolean {
  return node.language === 'postgres' && node.kind === 'type_alias' &&
    node.decorators?.includes('postgres:type') === true &&
    decodePostgresTypeRenameDescriptor(node.decorators) === null;
}

/**
 * Carry effective enum identity and membership across ordered ALTER TYPE
 * renames without classifying every renamed PostgreSQL type as an enum during
 * extraction. A rename becomes enum-specific only when its latest live source
 * in the same migration stream is an enum state.
 */
export function postgresEnumLifecycleEdges(queries: QueryBuilder): Edge[] {
  const byStream = new Map<string, EnumLifecycleEvent[]>();
  const append = (node: Node, event: EnumLifecycleEvent): void => {
    const stream = migrationStream(node.filePath);
    const events = byStream.get(stream);
    if (events) events.push(event);
    else byStream.set(stream, [event]);
  };

  for (const node of queries.iterateNodesByLanguage('postgres')) {
    const typeRename = decodePostgresTypeRenameDescriptor(node.decorators);
    if (typeRename) {
      append(node, { kind: 'type-rename', node, descriptor: typeRename, position: position(node) });
      continue;
    }
    const valueMutation = decodePostgresEnumValueMutationDescriptor(node.decorators);
    if (valueMutation) {
      append(node, {
        kind: 'value-mutation',
        node,
        descriptor: valueMutation,
        position: position(node),
      });
      continue;
    }
    if (isEnumDeclaration(node)) {
      append(node, { kind: 'enum-declaration', node, position: position(node) });
    } else if (isPlainTypeDeclaration(node)) {
      append(node, { kind: 'type-declaration', node, position: position(node) });
    }
  }

  const edges = new Map<string, Edge>();
  const addEdge = (edge: Edge): void => {
    edges.set(`${edge.source}\u0000${edge.target}\u0000${edge.kind}`, edge);
  };
  const snapshotAlias = (state: EnumState): void => {
    if (!decodePostgresTypeRenameDescriptor(state.parent.decorators)) return;
    for (const [label, member] of state.members) {
      addEdge({
        source: state.parent.id,
        target: member.id,
        kind: 'contains',
        line: member.startLine,
        column: member.startColumn,
        provenance: 'tree-sitter',
        metadata: {
          synthesizedBy: POSTGRES_STRUCTURE_SYNTHESIZER,
          postgresRelation: 'enum-effective-containment',
          effectiveLabel: label,
        },
      });
    }
  };

  for (const events of byStream.values()) {
    events.sort((left, right) =>
      comparePostgresMigrationPosition(left.position, right.position) ||
      eventRank(left) - eventRank(right) ||
      (left.node.id < right.node.id ? -1 : left.node.id > right.node.id ? 1 : 0)
    );
    const states = new Map<string, EnumState>();

    for (const event of events) {
      if (event.kind === 'enum-declaration') {
        states.set(event.node.qualifiedName, {
          parent: event.node,
          members: nativeEnumMembers(queries, event.node),
        });
        continue;
      }
      if (event.kind === 'type-declaration') {
        // A later non-enum declaration with the same name invalidates an older
        // enum candidate; do not infer enum identity from stale history.
        states.delete(event.node.qualifiedName);
        continue;
      }
      if (event.kind === 'value-mutation') {
        const state = states.get(event.descriptor.enumType);
        if (!state) continue;
        if (event.descriptor.mutation === 'add') {
          if (!state.members.has(event.descriptor.targetValue)) {
            state.members.set(event.descriptor.targetValue, event.node);
          }
        } else {
          const sourceMember = state.members.get(event.descriptor.sourceValue);
          if (sourceMember) {
            // Native CREATE TYPE containment is extracted source history and is
            // deliberately not deleted by this cross-file synthesizer. Record
            // the state transition explicitly so callers can distinguish the
            // old, still-queryable label from the effective replacement.
            addEdge({
              source: sourceMember.id,
              target: event.node.id,
              kind: 'references',
              line: event.node.startLine,
              column: event.node.startColumn,
              provenance: 'tree-sitter',
              metadata: {
                synthesizedBy: POSTGRES_STRUCTURE_SYNTHESIZER,
                postgresRelation: 'enum-value-rename',
                enumType: event.descriptor.enumType,
                sourceValue: event.descriptor.sourceValue,
                targetValue: event.descriptor.targetValue,
              },
            });
          }
          state.members.delete(event.descriptor.sourceValue);
          state.members.set(event.descriptor.targetValue, event.node);
        }
        continue;
      }

      const source = states.get(event.descriptor.sourceType);
      if (!source) continue;
      snapshotAlias(source);
      states.delete(event.descriptor.sourceType);
      const target: EnumState = {
        parent: event.node,
        members: new Map(source.members),
      };
      states.set(event.descriptor.targetType, target);
      addEdge({
        source: source.parent.id,
        target: event.node.id,
        kind: 'references',
        line: event.node.startLine,
        column: event.node.startColumn,
        provenance: 'tree-sitter',
        metadata: {
          synthesizedBy: POSTGRES_STRUCTURE_SYNTHESIZER,
          postgresRelation: 'enum-rename',
          sourceType: event.descriptor.sourceType,
          targetType: event.descriptor.targetType,
        },
      });
    }

    for (const state of states.values()) snapshotAlias(state);
  }

  return [...edges.values()];
}
