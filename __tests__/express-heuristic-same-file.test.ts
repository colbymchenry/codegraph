/**
 * The Express resolver's middleware / controller / service name patterns pick
 * only the calling file's own declaration — another file's comes through an
 * `import` / `require`, the import resolver's. SvelteKit's remote functions'
 * `validate(arg)` went to the config loader's `validate` in another package,
 * and express' examples' `logger('dev')` to one example's `logger`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-express-heur-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { express: '^4.0.0' } }),
    'packages/kit/src/core/config/options.js': `export function validate(config) {
  return config;
}
`,
    'packages/kit/src/runtime/remote/query.js': `export function query(validate, arg) {
  return () => validate(arg);
}
`,
    'server/app.js': `const express = require('express');
const app = express();

function validateBody(req, res, next) {
  next();
}

app.post('/items', validateBody, (req, res) => res.send('ok'));
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

const targetFilesFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.filePath);
};

describe('Express name patterns', () => {
  it('never reach another file’s declaration by name', () => {
    expect(targetFilesFrom('packages/kit/src/runtime/remote/query.js')).not.toContain('packages/kit/src/core/config/options.js');
  });
});
