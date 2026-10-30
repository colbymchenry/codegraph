/**
 * A top-level binding an ES module doesn't export can't be named from another
 * file. sveltekit's `generate_manifest.js` keeps an unexported `resolve` that
 * other files' `resolve(…)` calls went to; typeorm's test inputs' local
 * `ColumnMetadata` took `import { ColumnMetadata } from "typeorm"`. Exported
 * forms all still count: the `export` keyword, `export { a as b }`,
 * `export default x`, `export default { a, b }`; so do classic scripts,
 * CommonJS files and functions assigned onto a prototype.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-esm-unexported-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', type: 'module' }),
    'src/manifest.js': `import { join } from 'node:path';
function resolve(event) { return join(event); }
export function manifest() { return resolve('x'); }
`,
    'src/adapters.js': `import { a } from './a.js';
function getAdapter(name) { return name; }
export default { getAdapter };
`,
    'src/listed.js': `import { a } from './a.js';
function helper() { return 1; }
export { helper };
`,
    'src/proto.js': `import { a } from './a.js';
function Params() {}
const prototype = Params.prototype;
prototype.render = function render() { return ''; };
export default Params;
`,
    'src/a.js': `export const a = 1;
`,
    'src/use.js': `import { helper } from './listed.js';
import Params from './proto.js';
export async function handle(event) {
  await resolve(event);
  getAdapter('xhr');
  helper();
  new Params().render();
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

describe('unexported ES module bindings', () => {
  it('are not reached from another file; every export form still is', () => {
    const handle = cg.getNodesInFile('src/use.js').find((n) => n.name === 'handle')!;
    const targets = cg
      .getOutgoingEdges(handle.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => `${cg.getNode(e.target)!.filePath}:${cg.getNode(e.target)!.name}`);
    expect(targets).not.toContain('src/manifest.js:resolve');
    expect(targets).toContain('src/adapters.js:getAdapter');
    expect(targets).toContain('src/listed.js:helper');
    expect(targets).toContain('src/proto.js:render');
  });
});
