/** Shared encoding for PostgreSQL constraint-removal migration facts. */

export const POSTGRES_DROP_CONSTRAINT_DECORATOR = 'postgres:drop-constraint';
export const POSTGRES_DROP_CONSTRAINT_DATA_PREFIX = 'postgres:drop-constraint-data:';
export const POSTGRES_RENAME_CONSTRAINT_DECORATOR = 'postgres:rename-constraint';
export const POSTGRES_RENAME_CONSTRAINT_DATA_PREFIX = 'postgres:rename-constraint-data:';

export interface PostgresDropConstraintDescriptor {
  table: string;
  constraintName: string;
}

export interface PostgresRenameConstraintDescriptor {
  table: string;
  sourceConstraint: string;
  targetConstraint: string;
}

export function encodePostgresDropConstraintDescriptor(
  descriptor: PostgresDropConstraintDescriptor
): string {
  return `${POSTGRES_DROP_CONSTRAINT_DATA_PREFIX}${JSON.stringify(descriptor)}`;
}

export function decodePostgresDropConstraintDescriptor(
  decorators: readonly string[] | undefined
): PostgresDropConstraintDescriptor | null {
  const encoded = decorators?.find((decorator) =>
    decorator.startsWith(POSTGRES_DROP_CONSTRAINT_DATA_PREFIX)
  );
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded.slice(POSTGRES_DROP_CONSTRAINT_DATA_PREFIX.length)) as
      Partial<PostgresDropConstraintDescriptor>;
    if (typeof value.table !== 'string' || typeof value.constraintName !== 'string') return null;
    return value as PostgresDropConstraintDescriptor;
  } catch {
    return null;
  }
}

export function encodePostgresRenameConstraintDescriptor(
  descriptor: PostgresRenameConstraintDescriptor
): string {
  return `${POSTGRES_RENAME_CONSTRAINT_DATA_PREFIX}${JSON.stringify(descriptor)}`;
}

export function decodePostgresRenameConstraintDescriptor(
  decorators: readonly string[] | undefined
): PostgresRenameConstraintDescriptor | null {
  const encoded = decorators?.find((decorator) =>
    decorator.startsWith(POSTGRES_RENAME_CONSTRAINT_DATA_PREFIX)
  );
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded.slice(POSTGRES_RENAME_CONSTRAINT_DATA_PREFIX.length)) as
      Partial<PostgresRenameConstraintDescriptor>;
    if (
      typeof value.table !== 'string' ||
      typeof value.sourceConstraint !== 'string' ||
      typeof value.targetConstraint !== 'string'
    ) return null;
    return value as PostgresRenameConstraintDescriptor;
  } catch {
    return null;
  }
}
