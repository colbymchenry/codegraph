/** Ordered PostgreSQL relation lifecycle facts used by migration synthesis. */

export const POSTGRES_DROP_RELATION_DECORATOR = 'postgres:drop-relation';
export const POSTGRES_DROP_RELATION_DATA_PREFIX = 'postgres:drop-relation-data:';

export type PostgresDroppedRelationKind =
  | 'table'
  | 'foreign-table'
  | 'view'
  | 'materialized-view';

export interface PostgresDropRelationDescriptor {
  relationName: string;
  relationKind: PostgresDroppedRelationKind;
}

export function encodePostgresDropRelationDescriptor(
  descriptor: PostgresDropRelationDescriptor
): string {
  return `${POSTGRES_DROP_RELATION_DATA_PREFIX}${JSON.stringify(descriptor)}`;
}

export function decodePostgresDropRelationDescriptor(
  decorators: readonly string[] | undefined
): PostgresDropRelationDescriptor | null {
  const encoded = decorators?.find((decorator) =>
    decorator.startsWith(POSTGRES_DROP_RELATION_DATA_PREFIX)
  );
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded.slice(POSTGRES_DROP_RELATION_DATA_PREFIX.length)) as
      Partial<PostgresDropRelationDescriptor>;
    if (
      typeof value.relationName !== 'string' ||
      !['table', 'foreign-table', 'view', 'materialized-view'].includes(
        value.relationKind ?? ''
      )
    ) return null;
    return value as PostgresDropRelationDescriptor;
  } catch {
    return null;
  }
}
