/**
 * A TS/JS member call reached through a host namespace — `chrome.storage.local
 * .get(k)`, `document.body.querySelector(s)` — ends in a platform API. Emitting
 * the bare method name for it let every such call exact-match whatever project
 * symbol shared the name, so a storage wrapper's `get` called itself (#1707).
 * Those are dropped. A chain rooted at a project value keeps the bare name:
 * `window.MyNs.run()` and `this.<field>.m()` reach real targets.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let dir: string;
let cg: CodeGraph;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1707-'));
  const w = (rel: string, body: string) => fs.writeFileSync(path.join(dir, rel), body);
  w(
    'storage.ts',
    'declare const chrome: any;\n' +
      'export const DraftHubStorage = {\n' +
      '  async get(key: string): Promise<unknown> {\n' +
      '    const result = await chrome.storage.local.get([key]);\n' +
      '    return result[key];\n' +
      '  },\n' +
      '};\n'
  );
  w(
    'dom.ts',
    'export function querySelector(sel: string): string { return sel; }\n' +
      'export function findRow(): unknown {\n' +
      '  return document.body.querySelector("tr");\n' +
      '}\n'
  );
  w(
    'service.ts',
    'declare const window: any;\n' +
      'export function ping(): string { return "pong"; }\n' +
      'export function viaGlobal(): string {\n' +
      '  return window.MyNs.ping();\n' +
      '}\n' +
      'export class Runner {\n' +
      '  constructor(private svc: { ping(): string }) {}\n' +
      '  run(): string { return this.svc.ping(); }\n' +
      '}\n'
  );
  cg = await CodeGraph.init(dir, { index: true });
  cg.resolveReferences();
});

afterAll(() => {
  cg.destroy();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite handle for a moment; the OS temp dir is swept anyway.
  }
});

const fn = (name: string, file: string) =>
  cg.getNodesByKind('function').find((n) => n.name === name && n.filePath === file)!;
const method = (qn: string) => cg.getNodesByKind('method').find((n) => n.qualifiedName === qn)!;
const callTargets = (id: string) =>
  cg
    .getOutgoingEdges(id)
    .filter((e) => e.kind === 'calls')
    .map((e) => e.target);

describe('TS/JS call through a host-global chain (#1707)', () => {
  it('does not make a storage wrapper call itself through chrome.storage.local.get', () => {
    const get = fn('get', 'storage.ts');
    expect(get).toBeDefined();
    expect(callTargets(get.id)).not.toContain(get.id);
  });

  it('does not bind document.body.querySelector to a same-named project function', () => {
    expect(callTargets(fn('findRow', 'dom.ts').id)).not.toContain(
      fn('querySelector', 'dom.ts').id
    );
  });

  it('keeps a chain rooted at a project value — window.MyNs.m() and this.<field>.m()', () => {
    const ping = fn('ping', 'service.ts').id;
    expect(callTargets(fn('viaGlobal', 'service.ts').id)).toContain(ping);
    expect(callTargets(method('Runner::run').id)).toContain(ping);
  });
});
