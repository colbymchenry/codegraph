import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['postgres']);
});

async function indexedPostgres(source: string): Promise<{
  graph: CodeGraph;
  projectDir: string;
}> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pg-preparse-'));
  fs.writeFileSync(path.join(projectDir, 'schema.sql'), `${source.trim()}\n`);
  const graph = CodeGraph.initSync(projectDir);
  await graph.indexAll();
  return { graph, projectDir };
}

function referencedTableNames(graph: CodeGraph, line: number): string[] {
  const file = graph.getNodesByQualifiedName('schema.sql')
    .find((node) => node.kind === 'file')!;
  return graph.getOutgoingEdges(file.id, ['references'])
    .filter((edge) => edge.line === line)
    .map((edge) => graph.getNode(edge.target))
    .filter((node) => node?.language === 'postgres' && node.kind === 'struct')
    .map((node) => node!.qualifiedName);
}

describe('PostgreSQL prepared-source resolution parity', () => {
  it('does not let a psql meta-command swallow the following SET search_path', async () => {
    const { graph, projectDir } = await indexedPostgres([
      '\\set tenant app',
      'SET search_path = app;',
      'CREATE TABLE app.users (id bigint);',
      'SELECT * FROM users;',
    ].join('\n'));
    try {
      expect(referencedTableNames(graph, 4)).toEqual(['app.users']);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not treat COPY FROM STDIN payload text as a search_path change', async () => {
    const { graph, projectDir } = await indexedPostgres([
      'CREATE TABLE app.users (id bigint);',
      'CREATE TABLE history.users (id bigint);',
      'CREATE TABLE public.seed (value text);',
      'SET search_path = app;',
      'COPY public.seed FROM STDIN WITH (FORMAT csv);',
      'SET search_path = history;',
      '\\.',
      'SELECT * FROM users;',
    ].join('\n'));
    try {
      expect(referencedTableNames(graph, 8)).toEqual(['app.users']);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
