/** Ordered PostgreSQL type/enum rename facts used by graph synthesis. */

export const POSTGRES_TYPE_RENAME_DECORATOR = 'postgres:type-rename';
export const POSTGRES_TYPE_RENAME_DATA_PREFIX = 'postgres:type-rename-data:';
export const POSTGRES_ENUM_VALUE_MUTATION_DECORATOR = 'postgres:enum-value-mutation';
export const POSTGRES_ENUM_VALUE_MUTATION_DATA_PREFIX =
  'postgres:enum-value-mutation-data:';

export interface PostgresTypeRenameDescriptor {
  sourceType: string;
  targetType: string;
}

export type PostgresEnumValueMutationDescriptor =
  | {
      mutation: 'add';
      enumType: string;
      targetValue: string;
    }
  | {
      mutation: 'rename';
      enumType: string;
      sourceValue: string;
      targetValue: string;
    };

export function encodePostgresTypeRenameDescriptor(
  descriptor: PostgresTypeRenameDescriptor
): string {
  return `${POSTGRES_TYPE_RENAME_DATA_PREFIX}${JSON.stringify(descriptor)}`;
}

export function decodePostgresTypeRenameDescriptor(
  decorators: readonly string[] | undefined
): PostgresTypeRenameDescriptor | null {
  const encoded = decorators?.find((decorator) =>
    decorator.startsWith(POSTGRES_TYPE_RENAME_DATA_PREFIX)
  );
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded.slice(POSTGRES_TYPE_RENAME_DATA_PREFIX.length)) as
      Partial<PostgresTypeRenameDescriptor>;
    if (typeof value.sourceType !== 'string' || typeof value.targetType !== 'string') {
      return null;
    }
    return value as PostgresTypeRenameDescriptor;
  } catch {
    return null;
  }
}

export function encodePostgresEnumValueMutationDescriptor(
  descriptor: PostgresEnumValueMutationDescriptor
): string {
  return `${POSTGRES_ENUM_VALUE_MUTATION_DATA_PREFIX}${JSON.stringify(descriptor)}`;
}

export function decodePostgresEnumValueMutationDescriptor(
  decorators: readonly string[] | undefined
): PostgresEnumValueMutationDescriptor | null {
  const encoded = decorators?.find((decorator) =>
    decorator.startsWith(POSTGRES_ENUM_VALUE_MUTATION_DATA_PREFIX)
  );
  if (!encoded) return null;
  try {
    const value = JSON.parse(
      encoded.slice(POSTGRES_ENUM_VALUE_MUTATION_DATA_PREFIX.length)
    ) as Partial<PostgresEnumValueMutationDescriptor>;
    if (
      (value.mutation !== 'add' && value.mutation !== 'rename') ||
      typeof value.enumType !== 'string' ||
      typeof value.targetValue !== 'string' ||
      (value.mutation === 'rename' && typeof value.sourceValue !== 'string')
    ) {
      return null;
    }
    return value as PostgresEnumValueMutationDescriptor;
  } catch {
    return null;
  }
}
