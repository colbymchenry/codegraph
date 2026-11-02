/**
 * Tier synthesis, http-client channel: an absolute URL to a third-party host
 * must never link to this project's own routes, while a relative URL to the
 * same path still must (issue #2974).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type { Edge, Node } from '../src/types';

let tmpDir: string;
let cg: CodeGraph;

function write(rel: string, content: string): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tier-http-abs-'));
  write(
    'package.json',
    JSON.stringify({
      name: 'mono',
      workspaces: ['apps/*'],
      dependencies: { express: '4' },
    })
  );
  write(
    'apps/api/src/app.ts',
    "import express from 'express'\n" +
      "import { getUser } from './users'\n" +
      'const app = express()\n' +
      "app.get('/users/:id', getUser)\n" +
      'export default app\n'
  );
  write('apps/api/src/users.ts', "import { prisma } from './db'\nexport async function getUser(req, res) {\n  res.json(await prisma.user.findUnique({ where: { id: req.params.id } }))\n}\n");
  write('apps/api/src/db.ts', "export const prisma = { user: { findUnique() { return {} } } }\n");
  write(
    'apps/web/client.ts',
    "export async function loadExternal(name) {\n" +
      "  const r = await fetch(`https://api.github.com/users/${name}`)\n" +
      "  return r\n" +
      "}\n" +
      "export async function loadLocal(id) {\n" +
      "  const r = await fetch(`/users/${id}`)\n" +
      "  return r\n" +
      "}\n"
  );
  cg = CodeGraph.initSync(tmpDir);
  await cg.indexAll();
});

afterAll(() => {
  cg?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sym = (name: string): Node => {
  const found = cg.getNodesByName(name).filter((n) => n.kind !== 'route' && n.kind !== 'file');
  if (!found[0]) throw new Error(`no symbol ${name}`);
  return found[0];
};
const route = (name: string): Node => {
  const r = cg.getNodesByKind('route').find((r) => r.name === name);
  if (!r) throw new Error(`no route ${name}: ${cg.getNodesByKind('route').map((r) => r.name).join(', ')}`);
  return r;
};
const synthesized = (from: Node, by: string): Edge[] =>
  cg.getOutgoingEdges(from.id).filter((e) => e.provenance === 'heuristic' && (e.metadata as Record<string, unknown>)?.synthesizedBy === by);

describe('http-client: absolute third-party URLs must not link to own routes', () => {
  it('produces no edge for fetch(`https://api.github.com/users/${name}`)', () => {
    expect(synthesized(sym('loadExternal'), 'http-client')).toHaveLength(0);
  });

  it('still links fetch(`/users/${id}`) to the own route GET /users/:id', () => {
    const edges = synthesized(sym('loadLocal'), 'http-client');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(route('GET /users/:id').id);
    expect(edges[0]!.kind).toBe('calls');
    expect((edges[0]!.metadata as Record<string, unknown>).href).toBe('/users/${…}');
    expect((edges[0]!.metadata as Record<string, unknown>).tier).toBe('client→server');
  });
});
