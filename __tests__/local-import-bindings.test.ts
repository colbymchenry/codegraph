import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root: string | undefined;
let cg: CodeGraph | undefined;
afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function expectLocalCall(files: Record<string, string>) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-local-binding-'));
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source);
  }
  cg = await CodeGraph.init(root, { index: true });
  cg.resolveReferences();
  const functions = cg.getNodesByKind('function');
  const caller = functions.find(n => n.name === 'configure')!;
  const target = functions.find(n => n.name === 'localHelper')!;
  expect(caller).toBeDefined();
  expect(target).toBeDefined();
  expect(cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => e.target))
    .toContain(target.id);
}

describe('local import bindings survive external-package guards', () => {
  it.each(['link:', 'file:'])('keeps a %s dependency outside workspace globs', async protocol => {
    await expectLocalCall({
      'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { '@demo/local': `${protocol}./linked` } }),
      'packages/app/linked/package.json': JSON.stringify({ name: '@demo/local' }),
      'packages/app/linked/index.ts': 'export function localHelper() { return 1; }',
      'packages/app/main.ts': "import { localHelper } from '@demo/local'; export function configure() { return localHelper(); }",
    });
  });

  it.each(['link:', 'file:'])('keeps a root %s dependency subpath without workspaces', async protocol => {
    await expectLocalCall({
      'package.json': JSON.stringify({ dependencies: { '@demo/local': `${protocol}./linked` } }),
      'linked/package.json': JSON.stringify({ name: '@demo/local' }),
      'linked/utils.ts': 'export function localHelper() { return 1; }',
      'main.ts': "import { localHelper } from '@demo/local/utils'; export function configure() { return localHelper(); }",
    });
  });

  it('keeps a root directory import described by a nested baseUrl', async () => {
    await expectLocalCall({
      'lib/utils.ts': 'export function localHelper() { return 1; }',
      'consumer/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '..' } }),
      'consumer/main.ts': "import { localHelper } from 'lib/utils'; export function configure() { return localHelper(); }",
    });
  });
});
