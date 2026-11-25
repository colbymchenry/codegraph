import type { FilterSpec } from '../stores/types';

/** Parse the dashboard's filter bar text into filter specs. */

const OPERATORS: Record<string, FilterSpec['op']> = {
  ':': 'eq',
  '~': 'contains',
  '>': 'gt',
  '<': 'lt',
};

/** `title~sales kind:chart column>3` → three specs. */
export function parseFilterText(text: string): FilterSpec[] {
  const specs: FilterSpec[] = [];
  for (const token of tokenize(text)) {
    const spec = parseToken(token);
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Split on whitespace, honouring double-quoted values. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (current.length > 0) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** One `field<op>value` token, or null when it does not parse. */
export function parseToken(token: string): FilterSpec | null {
  for (const [symbol, op] of Object.entries(OPERATORS)) {
    const at = token.indexOf(symbol);
    if (at <= 0) continue;
    const field = token.slice(0, at).trim();
    const value = token.slice(at + symbol.length).trim();
    if (field.length === 0 || value.length === 0) return null;
    return { field, op, value };
  }
  return null;
}

/** Render specs back to filter-bar text — the round trip the URL uses. */
export function formatFilterText(specs: readonly FilterSpec[]): string {
  const symbolFor = (op: FilterSpec['op']): string =>
    Object.entries(OPERATORS).find(([, candidate]) => candidate === op)?.[0] ?? ':';
  return specs
    .map((spec) => {
      const value = /\s/.test(spec.value) ? `"${spec.value}"` : spec.value;
      return `${spec.field}${symbolFor(spec.op)}${value}`;
    })
    .join(' ');
}
