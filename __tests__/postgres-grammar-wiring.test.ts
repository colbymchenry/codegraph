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
});
