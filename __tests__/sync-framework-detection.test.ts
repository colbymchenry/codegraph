import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
const projects: Array<{ root: string; graph: CodeGraph }> = [];
afterEach(async () => {
  for (const { root, graph } of projects.splice(0)) {
    await graph.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
describe('framework detection across incremental updates', () => {
  it.each([false, true])('extracts newly introduced Express routes (scoped=%s)', async (scoped) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-framework-sync-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/app.ts'), 'export function boot() { return 1; }\n');
    const graph = CodeGraph.initSync(root);
    projects.push({ root, graph });
    await graph.indexAll();
    expect(graph.getDetectedFrameworks()).not.toContain('express');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.18.0' } }));
    fs.writeFileSync(path.join(root, 'src/routes.js'), "const app = express();\napp.get('/hello', handler);\n");
    await graph.sync(scoped ? { paths: ['src/routes.js'] } : {});
    expect(graph.getDetectedFrameworks()).toContain('express');
    expect(graph.getNodesInFile('src/routes.js').some(node => node.kind === 'route' && node.name === 'GET /hello')).toBe(true);
  });
});
