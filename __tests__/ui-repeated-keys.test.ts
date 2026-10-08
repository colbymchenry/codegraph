/**
 * The viewer draws its lists keyed by id, and a repeated id stops the page
 * from drawing at all — Entry points on hono, the Symbol view of every Vue /
 * Svelte / Astro component. Two payloads repeated themselves:
 *
 * - the routes list was a row per (route, edge), so an inline handler came
 *   back once per call in its body (`GET /stream/text` as `streamText`,
 *   `writeln` and `sleep`). A route is one row: its bound handler, or the
 *   route itself as an inline handler;
 * - a component's members listed its script's symbols twice, and the
 *   component and its file among them.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { buildRoutes } from '../src/ui-server/api/routes';
import { buildNode } from '../src/ui-server/api/node';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ui-repeated-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { express: '^4.0.0', astro: '^4.0.0' } }),
    'server/app.js': `const express = require('express');
const app = express();

function loadUser(id) { return { id }; }
function audit(id) { return id; }
function render(user) { return user; }
function listUsers(req, res) { res.json([]); }
function showUser(req, res) { res.json(loadUser(req.params.id)); }

app.get('/users/:id/card', async (req, res) => {
  const user = loadUser(req.params.id);
  audit(user.id);
  res.send(render(user));
});

app.get('/users', listUsers);
app.get('/users/:id', showUser);
`,
    'src/components/Card.astro': `---
import Badge from './Badge.astro';
import { format } from '../lib/format';
const title = format('card');
---
<div><Badge />{title}</div>
`,
    'src/components/Badge.astro': `<span>badge</span>
`,
    'src/lib/format.ts': `export function format(s: string): string {
  return s.trim();
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('the routes list', () => {
  it('has one row per route', () => {
    const { entries } = buildRoutes(cg, new URLSearchParams());
    const ids = entries.map((e) => e.routeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names an inline handler as one, and a bound handler by its name', () => {
    const { entries } = buildRoutes(cg, new URLSearchParams());
    const card = entries.find((e) => e.url === 'GET /users/:id/card')!;
    expect(card).toMatchObject({ handler: 'inline handler', inline: true, handlerId: card.routeId });
    expect(entries.find((e) => e.url === 'GET /users/:id')).toMatchObject({ handler: 'showUser', inline: false });
  });
});

describe('a component’s members', () => {
  it('lists each symbol once, and never the component or a file', async () => {
    const component = cg.getNodesByKind('component').find((n) => n.name === 'Card')!;
    const payload = (await buildNode(cg, root, component.id)) as { members: { items: Array<{ id: string; kind: string }> } };
    const ids = payload.members.items.map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(component.id);
    expect(payload.members.items.map((m) => m.kind)).not.toContain('file');
  });
});
