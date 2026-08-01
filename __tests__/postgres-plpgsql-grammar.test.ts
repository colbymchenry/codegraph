import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  getPostgresPlpgsqlParser,
  initGrammars,
  loadGrammarsForLanguages,
  readGrammarWasmBytes,
} from '../src/extraction/grammars';

describe('PostgreSQL PL/pgSQL companion grammar', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['postgres']);
  });

  it('pre-reads the pinned companion bytes with the PostgreSQL grammar', async () => {
    const bytes = await readGrammarWasmBytes(['postgres']);

    expect(bytes.postgres).toBeInstanceOf(Uint8Array);
    expect(bytes.plpgsql).toBeInstanceOf(Uint8Array);
    expect(bytes.plpgsql.byteLength).toBe(137_462);
    expect(createHash('sha256').update(bytes.plpgsql).digest('hex')).toBe(
      '24a4b44b5263cbf78716d5a7301b5ade6f8696dbce08365421e785382427694e'
    );
  });

  it('loads a dedicated parser that structurally separates embedded SQL', () => {
    const parser = getPostgresPlpgsqlParser();
    expect(parser).not.toBeNull();

    const tree = parser!.parse([
      'DECLARE',
      '  selected_id uuid;',
      'BEGIN',
      '  SELECT id INTO selected_id FROM public.users WHERE active;',
      '  PERFORM public.touch_user(selected_id);',
      'END;',
    ].join('\n'));

    expect(tree.rootNode.hasError).toBe(false);
    const syntax = tree.rootNode.toString();
    expect(syntax).toContain('(pl_block ');
    expect(syntax).toContain('(stmt_execsql (sql_expression))');
    expect(syntax).toContain('(stmt_perform (kw_perform) (sql_expression))');
    tree.delete();
  });
});
