/**
 * Python body docstrings (#1905)
 *
 * `getPrecedingDocstring` only walks preceding comment siblings, so a Python
 * docstring — a bare string literal first in the body — never reached the
 * `docstring` column, never entered `nodes_fts`, and was never shown. The
 * identical sentence written as a leading `#` comment was both.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function docstrings(code: string): Map<string, string | undefined> {
  return new Map(extractFromSource('ledger.py', code).nodes.map((n) => [n.name, n.docstring]));
}

describe('Python body docstrings', () => {
  it('extracts the same sentence from a docstring as from a leading comment (#1905)', () => {
    // The issue's repro: one sentence, two positions. Before this change only
    // `audit_ledger` carried it.
    const byName = docstrings(`
def reconcile_ledger():
    """Settle the nightly discrepancy with the bank."""
    return LEDGER

# Settle the nightly discrepancy with the bank.
def audit_ledger():
    return LEDGER
`);
    expect(byName.get('reconcile_ledger')).toBe('Settle the nightly discrepancy with the bank.');
    expect(byName.get('audit_ledger')).toBe('Settle the nightly discrepancy with the bank.');
  });

  it('dedents a multi-line docstring to its own left margin', () => {
    const byName = docstrings(`
class Ledger:
    """Post entries to the general ledger.

    Nightly reconciliation runs against the bank feed.
    """
    pass
`);
    expect(byName.get('Ledger')).toBe(
      'Post entries to the general ledger.\n\nNightly reconciliation runs against the bank feed.',
    );
  });

  it("keeps both when a definition carries a comment AND a docstring", () => {
    // Two things the author wrote about the same symbol; the column is free
    // text, so neither is dropped.
    const byName = docstrings(`
# Legacy path, kept for the 2019 import.
def reconcile_ledger():
    """Settle the nightly discrepancy with the bank."""
    return LEDGER
`);
    expect(byName.get('reconcile_ledger')).toBe(
      'Legacy path, kept for the 2019 import.\n\nSettle the nightly discrepancy with the bank.',
    );
  });

  it('handles the single-quote and prefixed forms', () => {
    const byName = docstrings(`
def with_single():
    '''Single-quoted docstring.'''
    return 1

def with_raw_prefix():
    r"""Raw \\d+ docstring."""
    return 2
`);
    expect(byName.get('with_single')).toBe('Single-quoted docstring.');
    expect(byName.get('with_raw_prefix')).toBe('Raw \\d+ docstring.');
  });

  it('skips an f-string first statement — that is code, not prose', () => {
    const byName = docstrings(`
def interpolated(name):
    f"""Hello {name}."""
    return name
`);
    expect(byName.get('interpolated') ?? null).toBeNull();
  });

  it('does not treat a non-string first statement as prose', () => {
    const byName = docstrings(`
def no_docstring():
    total = 0
    return total
`);
    expect(byName.get('no_docstring') ?? null).toBeNull();
  });
});
