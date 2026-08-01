/** Canonical PostgreSQL identifier serialization shared by extraction/resolution. */

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;

/**
 * Serialize one already-decoded PostgreSQL identifier without losing segment
 * boundaries. PostgreSQL folds unquoted names to lower case, so lower-case
 * simple identifiers can stay bare; every other value is quoted and escaped.
 */
export function serializePostgresIdentifier(identifier: string): string {
  return SIMPLE_IDENTIFIER.test(identifier)
    ? identifier
    : `"${identifier.replace(/"/g, '""')}"`;
}

export function serializePostgresQualifiedName(parts: readonly string[]): string {
  return parts.map(serializePostgresIdentifier).join('.');
}

/**
 * Parse canonical or user-entered PostgreSQL dotted names. Quoted dots remain
 * inside their identifier segment and doubled quotes are decoded.
 */
export function parsePostgresQualifiedName(value: string): string[] | null {
  const input = value.trim();
  if (!input) return null;
  const parts: string[] = [];
  let index = 0;

  while (index < input.length) {
    while (/\s/.test(input[index] ?? '')) index++;
    if (index >= input.length) return null;

    let part = '';
    if (input[index] === '"') {
      index++;
      let closed = false;
      while (index < input.length) {
        const char = input[index++]!;
        if (char !== '"') {
          part += char;
        } else if (input[index] === '"') {
          part += '"';
          index++;
        } else {
          closed = true;
          break;
        }
      }
      if (!closed || !part) return null;
    } else {
      const start = index;
      while (index < input.length && input[index] !== '.') index++;
      part = input.slice(start, index).trim().toLowerCase();
      if (!part || /\s/.test(part)) return null;
    }

    while (/\s/.test(input[index] ?? '')) index++;
    parts.push(part);
    if (index >= input.length) break;
    if (input[index] !== '.') return null;
    index++;
  }

  return parts.length > 0 ? parts : null;
}

export function appendPostgresIdentifier(qualifiedName: string, identifier: string): string {
  return `${qualifiedName}.${serializePostgresIdentifier(identifier)}`;
}

export function qualifyPostgresName(schema: string, name: string): string | null {
  const parts = parsePostgresQualifiedName(name);
  return parts ? serializePostgresQualifiedName([schema, ...parts]) : null;
}

export function isPostgresQualifiedName(name: string): boolean {
  return (parsePostgresQualifiedName(name)?.length ?? 0) > 1;
}
