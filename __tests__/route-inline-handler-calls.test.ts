/**
 * The calls an inline route handler makes keep their receivers. Read bare,
 * hono's `app.get('/', (c) => c.text('Hello'))` called the one other `text`
 * in the project — its client's `ClientResponse.text` — 419 times; kept as
 * `c.text` it resolves like any other member call, and `userService.lookup()`
 * reaches the service it names.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-inline-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'api', dependencies: { hono: '^4' } }),
    'src/client/types.ts': `export interface ClientResponse {
  text(): Promise<string>;
}
`,
    'src/services.ts': `export const userService = {
  lookup(id: number) {
    return { id };
  },
};
`,
    'src/routes/app.ts': `import { Hono } from 'hono';
import { userService } from '../services';

const app = new Hono();

app.get('/hello', (c) => c.text('Hello'));

app.get('/users/:id', async (c) => {
  const user = await userService.lookup(1);
  return c.json(user);
});

export default app;
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

const routeCalls = (name: string) => {
  const route = cg.getNodesByKind('route').find((r) => r.name.endsWith(name));
  if (!route) return [];
  return cg.getOutgoingEdges(route.id).filter((e) => e.kind === 'calls').map((e) => {
    const t = cg.getNode(e.target)!;
    return `${t.filePath}: ${t.qualifiedName}`;
  }).sort();
};

describe('inline route handler calls', () => {
  it('are not a same-named method of an unrelated type', () => {
    expect(routeCalls('/hello')).not.toContain('src/client/types.ts: ClientResponse::text');
  });

  it('reach the service a member call names', () => {
    expect(routeCalls('/users/:id')).toContain('src/services.ts: userService::lookup');
  });
});
