import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { vueResolver } from '../src/resolution/frameworks/vue';
import { vueRouteTable } from '../src/resolution/frameworks/vue-router';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['typescript', 'javascript']);
});

describe('Nuxt default file routes', () => {
  it.each([
    ['pages/index.vue', '/'],
    ['app/pages/index.vue', '/'],
    ['app/pages/users/index.vue', '/users'],
    ['app/pages/(marketing)/about.vue', '/about'],
    ['app/pages/users/[id].vue', '/users/:id'],
    ['app/pages/[[slug]].vue', '/:slug?'],
    ['app/pages/[...slug].vue', '/*slug'],
    ['apps/site/app/pages/users-[group]/[id].vue', '/users-:group/:id'],
    ['app\\pages\\index.vue', '/'],
    ['server/api/index.get.ts', 'GET /api'],
    ['server/api/users/[id].post.ts', 'POST /api/users/:id'],
    ['server/api/users/index.ts', 'ANY /api/users'],
    ['server/routes/health.get.js', 'GET /health'],
    ['server/routes/index.ts', 'ANY /'],
    ['server/routes/files/[...path].ts', 'ANY /files/*path'],
    ['server/api/[...].ts', 'ANY /api/*'],
  ])('%s becomes %s', (file, route) => {
    expect(
      vueResolver.extract!(file, 'export default defineEventHandler(() => "ok")').nodes.map(
        (n) => n.name,
      ),
    ).toEqual([route]);
  });

  it.each([
    'server/api/README.md',
    'server/api/types.d.ts',
    'server/utils/health.ts',
    'components/Index.vue',
  ])('does not turn %s into an endpoint', (file) => {
    expect(vueResolver.extract!(file, '').nodes).toEqual([]);
  });

  it('binds a default export and a wrapped handler without treating wrapper options as handlers', () => {
    for (const source of [
      'export default handler',
      'export default defineEventHandler(handler)',
      'export default eventHandler(handler)',
      'export default defineEventHandler({ onRequest: middleware, handler })',
    ]) {
      const result = vueResolver.extract!('server/api/x.get.ts', source);
      expect(result.references).toEqual([
        expect.objectContaining({
          fromNodeId: result.nodes[0].id,
          referenceName: 'handler',
          referenceKind: 'references',
        }),
      ]);
    }
    for (const source of [
      'export default defineEventHandler(() => load())',
      'export default defineEventHandler({ onRequest: middleware, handler() { return load(); } })',
    ]) {
      expect(vueResolver.extract!('server/api/x.ts', source).references).toEqual([
        expect.objectContaining({ referenceName: 'load', referenceKind: 'calls' }),
      ]);
    }
  });

  it('includes root-level pages in the Vue navigation route table', () => {
    const nodes = vueResolver.extract!('pages/index.vue', '<template>Home</template>').nodes;
    const table = vueRouteTable({ getNodesByKind: () => nodes } as any);
    expect(table.byRoot.get('')?.exact.get('/')).toBe(nodes[0]);
  });
});

describe('Nuxt server routes through indexing', () => {
  let graph: CodeGraph | undefined;
  let dir: string | undefined;
  afterEach(() => {
    graph?.close();
    graph = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('resolves a method-qualified endpoint to its imported handler', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nuxt-routes-'));
    fs.mkdirSync(path.join(dir, 'server/api'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { nuxt: '^4.0.0' } }),
    );
    fs.writeFileSync(path.join(dir, 'handler.ts'), 'export function handler() { return 1; }');
    fs.writeFileSync(
      path.join(dir, 'server/api/users.get.ts'),
      "import { handler } from '../../handler'; export default defineEventHandler(handler);",
    );
    graph = await CodeGraph.init(dir, { index: true });
    const routes = graph.getNodesByKind('route');
    expect(routes.map((n) => n.name)).toEqual(['GET /api/users']);
    const handler = graph.getNodesByKind('function').find((n) => n.name === 'handler');
    expect(handler).toBeDefined();
    expect(graph.getOutgoingEdges(routes[0].id)).toContainEqual(
      expect.objectContaining({ target: handler!.id, kind: 'references' }),
    );
  });
});
