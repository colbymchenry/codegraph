/**
 * A TS/JS call two or more fields deep from `this` — `this.cache.list.push(1)`,
 * `this.extractor.functionTypes.includes(t)` — keeps no receiver the resolver
 * can type, so it is matched by its method's name alone (#2948). Such a call:
 * - is never a call of a property or a field, whatever shares the name;
 * - is never a project method when the name is one of JavaScript's own
 *   collection, string or promise methods (`push`, `includes`, `has`, `set`),
 *   as for `o.data.push()` on a parameter;
 * - still reaches a project method of any other name.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deep-this-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

/** What the method with this qualified name calls, as `kind qualifiedName (file:line)`. */
function callsFrom(qualifiedName: string): string[] {
  const from = [...cg!.getNodesByKind('method'), ...cg!.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName);
  expect(from, `${qualifiedName} should be indexed`).toBeDefined();
  return cg!.getOutgoingEdges(from!.id).filter((e) => e.kind === 'calls')
    .map((e) => { const t = cg!.getNode(e.target)!; return `${t.kind} ${t.qualifiedName} (${t.filePath}:${t.startLine})`; })
    .sort();
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('a call two fields deep from this (#2948)', () => {
  it('links neither a built-in method name nor a property', async () => {
    await index({
      'heap.ts':
        'export class BinaryHeap { push(x: number): void {} }\n' +
        'export interface Conf { includes: string[]; }\n',
      'use.ts':
        'export class Scene {\n' +
        '  cache = { list: [] as number[], names: [] as string[] };\n' +
        '  a() { this.cache.list.push(1); }\n' +
        '  b(t: string) { return this.cache.names.includes(t); }\n' +
        '}\n' +
        'export function c(o: { data: number[] }) { o.data.push(1); }\n',
    });
    expect(callsFrom('Scene::a')).toEqual([]);
    expect(callsFrom('Scene::b')).toEqual([]);
    expect(callsFrom('c')).toEqual([]);
  });

  it('still reaches a project method of another name', async () => {
    await index({
      'api.ts': 'export class SceneApi { refreshAll(): void {} }\n',
      'portal.ts':
        "import { SceneApi } from './api';\n" +
        'export class Portal {\n' +
        '  constructor(private collab: { api: SceneApi }) {}\n' +
        '  open() { this.collab.api.refreshAll(); }\n' +
        '}\n',
    });
    expect(callsFrom('Portal::open')).toEqual(['method SceneApi::refreshAll (api.ts:1)']);
  });
});
