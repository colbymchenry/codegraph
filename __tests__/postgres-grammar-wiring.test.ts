import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  detectLanguage,
  getParser,
  getSupportedLanguages,
  initGrammars,
  isLanguageSupported,
  isSourceFile,
  loadGrammarsForLanguages,
  readGrammarWasmBytes,
} from '../src/extraction/grammars';
import { preParsePostgresSource } from '../src/extraction/languages/postgres';

describe('PostgreSQL grammar wiring', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['postgres']);
  });

  it('recognizes SQL files as PostgreSQL source', () => {
    expect(detectLanguage('migrations/001_create_users.sql')).toBe('postgres');
    expect(detectLanguage('migrations/001_create_users.SQL')).toBe('postgres');
    expect(detectLanguage('scripts/maintenance.psql')).toBe('postgres');
    expect(detectLanguage('scripts/maintenance.pgsql')).toBe('postgres');
    expect(isSourceFile('migrations/001_create_users.sql')).toBe(true);
    expect(isSourceFile('scripts/maintenance.psql')).toBe(true);
    expect(isSourceFile('scripts/maintenance.pgsql')).toBe(true);
    expect(isLanguageSupported('postgres')).toBe(true);
    expect(getSupportedLanguages()).toContain('postgres');
  });

  it('ships and loads the vendored PostgreSQL grammar', async () => {
    const grammarBytes = await readGrammarWasmBytes(['postgres']);
    expect(grammarBytes.postgres?.byteLength).toBeGreaterThan(0);
    expect(createHash('sha256').update(grammarBytes.postgres!).digest('hex')).toBe(
      '084883e58414c407dfac6f37f0facc983afdfe8103e17f5fd2ca138b79a22b92'
    );

    const parser = getParser('postgres');
    expect(parser).not.toBeNull();

    const tree = parser!.parse(
      'CREATE TABLE public.users (id bigint PRIMARY KEY); SELECT id FROM public.users;'
    );
    expect(tree!.rootNode.hasError).toBe(false);
    tree!.delete();
  });

  it('prepares psql variables, COPY payloads, and valid CHECK comparisons without shifting offsets', () => {
    const source = [
      "\\set winner_id 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'",
      "SELECT public.merge_user(:'winner_id'::uuid);",
      'CREATE TABLE audit.events (',
      '  op text,',
      '  record jsonb,',
      "  CHECK (op IN ('INSERT', 'UPDATE') = (record IS NOT NULL))",
      ');',
      'COPY audit.events (op, record) FROM STDIN;',
      'INSERT\t{"id": 1}',
      '\\.',
      'SELECT * FROM audit.events;',
    ].join('\n');
    const prepared = preParsePostgresSource(source);
    expect(prepared.length).toBe(source.length);
    expect([...prepared.matchAll(/\n/g)].map((match) => match.index))
      .toEqual([...source.matchAll(/\n/g)].map((match) => match.index));
    expect(prepared.split('\n')[0]).toMatch(/^\s+$/);
    expect(prepared.split('\n')[8]).toMatch(/^\s+$/);
    expect(prepared.split('\n')[9]).toMatch(/^\s+$/);

    const unicode = "-- 😀\n\\set value 'x'\nSELECT :value::text;";
    const preparedUnicode = preParsePostgresSource(unicode);
    expect(preparedUnicode.length).toBe(unicode.length);
    expect(preparedUnicode).toMatch(/SELECT \$1\s+::text;/);

    const parser = getParser('postgres')!;
    const tree = parser.parse(prepared);
    expect(tree!.rootNode.hasError).toBe(false);
    tree!.delete();
  });

  it('limits COPY payload masking to real server and psql COPY commands', () => {
    const psqlCopy = [
      '\\copy audit.events FROM STDIN',
      'INSERT\t{"id": 1};',
      '\\.',
      'SELECT * FROM audit.events;',
    ].join('\n');
    const preparedPsqlCopy = preParsePostgresSource(psqlCopy);
    expect(preparedPsqlCopy.split('\n').slice(0, 3)).toEqual([
      expect.stringMatching(/^\s+$/),
      expect.stringMatching(/^\s+$/),
      expect.stringMatching(/^\s+$/),
    ]);
    expect(preparedPsqlCopy.split('\n')[3]).toBe('SELECT * FROM audit.events;');

    const psqlQueryCopy = [
      '\\copy (SELECT copy FROM stdin) TO STDOUT',
      'SELECT * FROM users;',
    ].join('\n');
    expect(preParsePostgresSource(psqlQueryCopy).split('\n')[1])
      .toBe('SELECT * FROM users;');

    const identifierUse = 'SELECT copy FROM stdin;\nSELECT * FROM users;';
    expect(preParsePostgresSource(identifierUse)).toBe(identifierUse);

    const protocolOnly = 'COPY audit.events FROM STDIN;\nSELECT * FROM users;';
    expect(preParsePostgresSource(protocolOnly)).toBe(protocolOnly);

    const csvCopy = [
      'COPY audit.events FROM STDIN WITH (FORMAT csv);',
      'INSERT,{"id": 1}',
      '\\.',
      'SELECT * FROM audit.events;',
    ].join('\n');
    const preparedCsvCopy = preParsePostgresSource(csvCopy);
    expect(preparedCsvCopy.split('\n')[1]).toMatch(/^\s+$/);
    expect(preparedCsvCopy.split('\n')[2]).toMatch(/^\s+$/);
    expect(preparedCsvCopy.split('\n')[3]).toBe('SELECT * FROM audit.events;');

    const queryCopy = 'COPY (SELECT copy FROM stdin) TO STDOUT;\nSELECT * FROM users;';
    expect(preParsePostgresSource(queryCopy)).toBe(queryCopy);

    const parser = getParser('postgres')!;
    for (const prepared of [
      preparedPsqlCopy,
      identifierUse,
      protocolOnly,
      preparedCsvCopy,
      queryCopy,
    ]) {
      const tree = parser.parse(prepared);
      expect(tree.rootNode.hasError).toBe(false);
      tree.delete();
    }
  });

  it('uses backslash escapes only in E/e strings while locating COPY payloads', () => {
    const sources = [
      // With standard_conforming_strings, the backslash is data and the quote
      // immediately after it terminates the ordinary string.
      String.raw`SELECT 'x\';`,
      // In an escape string, the first quote is escaped and the second closes
      // the literal. Exercise both accepted prefix spellings.
      String.raw`SELECT E'x\'';`,
      String.raw`SELECT e'x\'';`,
    ];

    for (const firstStatement of sources) {
      const source = [
        firstStatement,
        String.raw`\copy audit.psql_events FROM STDIN`,
        '1\tpsql payload',
        String.raw`\.`,
        'COPY audit.server_events FROM STDIN;',
        '2\tserver payload',
        String.raw`\.`,
        'SELECT * FROM audit.server_events;',
      ].join('\n');
      const prepared = preParsePostgresSource(source);
      const lines = prepared.split('\n');

      expect(prepared.length).toBe(source.length);
      expect(lines[0]).toBe(firstStatement);
      expect(lines[1]).toMatch(/^\s+$/);
      expect(lines[2]).toMatch(/^\s+$/);
      expect(lines[3]).toMatch(/^\s+$/);
      expect(lines[4]).toBe('COPY audit.server_events FROM STDIN;');
      expect(lines[5]).toMatch(/^\s+$/);
      expect(lines[6]).toMatch(/^\s+$/);
      expect(lines[7]).toBe('SELECT * FROM audit.server_events;');
    }
  });
});
