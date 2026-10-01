/**
 * A bare JS/TS call through a name imported from outside the repository
 * (`import { resolve } from 'node:path'`) means the package's function, never
 * another file's same-named symbol. A declaration of that name in an inner
 * scope of the calling file still shadows the import, and the call is that
 * local declaration's.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

function project(files: Record<string, string>): void {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-import-shadow-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

async function callTargets(caller: string): Promise<string[]> {
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = cg.getNodesByKind('function').find((n) => n.name === caller)!;
  expect(from).toBeDefined();
  return cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'calls')
    .map((e) => { const t = cg!.getNode(e.target)!; return `${t.filePath}:${t.name}:${t.startLine}`; });
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('a name imported from outside the repository', () => {
  it('is shadowed by a declaration in an inner scope of the calling file', async () => {
    project({
      'plugin.ts': "export function resolve() { return 'plugin'; }",
      'config.ts':
        "import { resolve } from 'node:path';\n" +
        "export function configure() {\n  function resolve() { return 'local'; }\n  return resolve();\n}\n",
    });
    expect(await callTargets('configure')).toEqual(['config.ts:resolve:3']);
  });

  it('binds no other file\'s symbol of that name', async () => {
    project({
      'package.json': JSON.stringify({ name: 'app', dependencies: { 'external-resolver': '^1.0.0' } }),
      'plugin.ts': "export function resolve() { return 'plugin'; }",
      'config.ts': "import { resolve } from 'external-resolver';\nexport function configure() { return resolve('src'); }\n",
    });
    expect(await callTargets('configure')).toEqual([]);
  });

  it('is not shadowed by its own top-level require binding', async () => {
    project({
      'package.json': JSON.stringify({ name: 'app', devDependencies: { supertest: '^6' } }),
      'app.js': "var request = require('supertest');\nfunction run(app) { return request(app); }\nmodule.exports = run;\n",
    });
    expect(await callTargets('run')).toEqual([]);
  });
});
