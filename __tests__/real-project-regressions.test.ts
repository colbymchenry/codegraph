import { it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { decodeLockInfo } from '../src/mcp/daemon-paths';
import { clearStaleDaemonLock } from '../src/mcp/daemon';

it('ADRC macro calls do not resolve to enum values; ordinary calls survive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-adrc-reg-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'maths.h'), '#define MAX(a,b) ((a) > (b) ? (a) : (b))\n');
    fs.writeFileSync(path.join(root, 'cli.c'), 'enum { MIN, MAX };\nint helper(void) { return 1; }\n');
    fs.writeFileSync(path.join(root, 'blackbox.c'), '#include "maths.h"\nint helper(void);\nint blackbox(void) { return MAX(helper(), 2); }\n');
    cg = CodeGraph.initSync(root); await cg.indexAll();
    const node = cg.getNodesByName('blackbox').find(n => n.kind === 'function')!;
    const calls = cg.getCallees(node.id).filter(x => x.edge.kind === 'calls');
    expect(calls.some(x => x.node.kind === 'enum_member')).toBe(false);
    expect(calls.some(x => x.node.name === 'helper')).toBe(true);
  } finally { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('CSQTT Go standard-library Size cannot bind a TypeScript interface', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-csqtt-reg-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'update.go'), 'package core\nimport "net"\nfunc verify(mask []byte) { net.IPMask(mask).Size() }\n');
    fs.writeFileSync(path.join(root, 'runtime.ts'), 'export interface Size { width: number; height: number }\n');
    cg = CodeGraph.initSync(root); await cg.indexAll();
    const node = cg.getNodesByName('verify').find(n => n.kind === 'function')!;
    expect(cg.getCallees(node.id).filter(x => x.edge.kind === 'calls' && x.node.language === 'typescript')).toEqual([]);
  } finally { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('preserves a live legacy daemon lock even without identity metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-legacy-reg-'));
  const file = path.join(root, 'daemon.pid');
  try {
    fs.writeFileSync(file, String(process.pid));
    expect(decodeLockInfo(String(process.pid))?.pid).toBe(process.pid);
    expect(clearStaleDaemonLock(file, process.pid, { allowLivePid: true })).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
