/**
 * PostgreSQL-only unresolved-reference intents.
 *
 * These values are deliberately not graph edge kinds. They carry the object
 * class that PostgreSQL resolution must enforce, then materialize as ordinary
 * `references` edges after an exact, schema-aware match. Keeping the intent on
 * the unresolved row prevents a type or sequence name from falling through to
 * the relation matcher (or to a generic fuzzy/framework strategy).
 */
export const POSTGRES_TYPE_REFERENCE_KIND = 'postgres_type' as const;
export const POSTGRES_SEQUENCE_REFERENCE_KIND = 'postgres_sequence' as const;

export const POSTGRES_OBJECT_REFERENCE_KINDS = [
  POSTGRES_TYPE_REFERENCE_KIND,
  POSTGRES_SEQUENCE_REFERENCE_KIND,
] as const;

export type PostgresObjectReferenceKind =
  (typeof POSTGRES_OBJECT_REFERENCE_KINDS)[number];

const POSTGRES_OBJECT_REFERENCE_KIND_SET = new Set<string>(
  POSTGRES_OBJECT_REFERENCE_KINDS
);

export function isPostgresObjectReferenceKind(
  value: string
): value is PostgresObjectReferenceKind {
  return POSTGRES_OBJECT_REFERENCE_KIND_SET.has(value);
}
