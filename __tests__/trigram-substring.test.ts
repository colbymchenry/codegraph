/**
 * Substring name search goes through the nodes_tri trigram index but must
 * return exactly what a plain LIKE scan returns, and the index must follow
 * node inserts, updates and deletes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';

const SOURCE = [
  'export function clusterTopics(): void {}',
  'export function ReconcileCluster(): void {}',
  'export function a_b(): void {}',
  'export function userPercent(): void {}',
  'export class ClusterWorker { reconcile(): void {} }',
].join('\n');

// Expected names come from reading the source, not from the index: a token
// matches when it occurs in the name, ignoring ASCII case, like SQL LIKE.
const NAMES = ['clusterTopics', 'ReconcileCluster', 'a_b', 'userPercent', 'ClusterWorker', 'reconcile'];

function expected(token: string): string[] {
  return NAMES.filter(n => n.toLowerCase().includes(token.toLowerCase())).sort();
}

describe('nodes_tri substring search', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matches a LIKE scan for long, short and wildcard tokens, and tracks edits', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tri-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), SOURCE);
    cg = await CodeGraph.init(dir, { index: true });

    // `a_b` and `ab` take the LIKE path (wildcard / under 3 chars); the rest use nodes_tri.
    for (const token of ['Cluster', 'CLUSTER', 'reconcile', 'Rec', 'ncile', 'a_b', 'ab']) {
      const found = cg.getNodesByNameSubstring(token, { limit: 100 }).map(n => n.name).sort();
      expect(found, token).toEqual(expected(token));
    }
    // No FTS token matches an infix, so this reaches the LIKE search (searchNodesLike).
    expect(cg.searchNodes('econcileClus').map(r => r.node.name)).toEqual(['ReconcileCluster']);

    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function renamedThing(): void {}\n');
    await cg.sync();
    expect(cg.getNodesByNameSubstring('Cluster')).toEqual([]);
    expect(cg.getNodesByNameSubstring('namedTh').map(n => n.name)).toEqual(['renamedThing']);
  });
  it('consults nodes_tri for long tokens only', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tri-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), SOURCE);
    cg = await CodeGraph.init(dir, { index: true });

    // Drop one node from the trigram index only: a query that uses the index misses it.
    const conn = DatabaseConnection.open(getDatabasePath(dir));
    try {
      conn.getDb().exec(`INSERT INTO nodes_tri(nodes_tri, rowid, name, qualified_name)
        SELECT 'delete', rowid, name, qualified_name FROM nodes WHERE name = 'clusterTopics'`);
    } finally {
      conn.close();
    }

    const names = (token: string) => cg!.getNodesByNameSubstring(token, { limit: 100 }).map(n => n.name);
    expect(names('Cluster')).not.toContain('clusterTopics');
    expect(names('Cluster')).toContain('ClusterWorker');
    // Under 3 chars or with a wildcard: plain LIKE, still sees it.
    expect(names('te')).toContain('clusterTopics');
    expect(names('cluster_opics')).toContain('clusterTopics');
  });
});
