/** Shared encoding for PostgreSQL foreign-key facts extracted from SQL. */

export const POSTGRES_FOREIGN_KEY_DECORATOR = 'postgres:foreign-key';
export const POSTGRES_FOREIGN_KEY_DATA_PREFIX = 'postgres:foreign-key-data:';

export interface PostgresForeignKeyDescriptor {
  sourceTable: string;
  targetTable: string;
  constraintName?: string;
  sourceColumns: string[];
  targetColumns: string[];
  match?: 'full' | 'partial' | 'simple';
  onDelete?: 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';
  onUpdate?: 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';
  deferrable?: boolean;
  initially?: 'deferred' | 'immediate';
  notValid?: boolean;
}

export function encodePostgresForeignKeyDescriptor(
  descriptor: PostgresForeignKeyDescriptor
): string {
  return `${POSTGRES_FOREIGN_KEY_DATA_PREFIX}${JSON.stringify(descriptor)}`;
}

export function decodePostgresForeignKeyDescriptor(
  decorators: readonly string[] | undefined
): PostgresForeignKeyDescriptor | null {
  const encoded = decorators?.find((decorator) =>
    decorator.startsWith(POSTGRES_FOREIGN_KEY_DATA_PREFIX)
  );
  if (!encoded) return null;

  try {
    const value = JSON.parse(encoded.slice(POSTGRES_FOREIGN_KEY_DATA_PREFIX.length)) as
      Partial<PostgresForeignKeyDescriptor>;
    if (
      typeof value.sourceTable !== 'string' ||
      typeof value.targetTable !== 'string' ||
      !Array.isArray(value.sourceColumns) ||
      !Array.isArray(value.targetColumns)
    ) {
      return null;
    }
    return value as PostgresForeignKeyDescriptor;
  } catch {
    return null;
  }
}
