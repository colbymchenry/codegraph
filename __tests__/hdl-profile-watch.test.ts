import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { FileWatcher } from '../src/sync/watcher';
import { HdlWatchScope } from '../src/sync/hdl-watch-scope';

async function waitFor(check: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('HDL watcher did not converge'); await new Promise(r => setTimeout(r, 25)); }
}
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-profile-watch-'));
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), {recursive:true}); fs.writeFileSync(path.join(root,file),text); };
  const config = (activeProfile: string) => JSON.stringify({hdl:{activeProfile,profiles:{
    first:{filelists:['build/units.f']},second:{filelists:['alt/units.f'],includeDirs:['alt/inc']},
  }}});
  write('.gitignore', 'build/\nalt/\nprivate/\nunrelated/\n');
  write('build/top.sv', '`include "../private/flags.inc"\nmodule top;\n`ifdef EXTRA\nfunction int extra();return 1;endfunction\n`endif\nendmodule');
  write('build/spare.sv', 'module spare; endmodule'); write('build/units.f','build/top.sv\n');
  write('private/flags.inc','// empty\n');
  write('alt/top.sv','`include "flags.txt"\nmodule other;\n`ifdef SECOND\nfunction int second();return 2;endfunction\n`endif\nendmodule');
  write('alt/units.f','alt/top.sv\n'); write('alt/inc/flags.txt','// empty\n');
  write('codegraph.json',config('first'));
  return {root,write,config};
}

it('watches profile filelists, explicit ignored sources and external-to-source header dependencies through the real event filter', async () => {
  const {root,write} = project(); const calls: Array<string[]|undefined> = [];
  const watcher = new FileWatcher(root, async paths => { calls.push(paths); return {filesChanged:1,durationMs:1}; },
    {inertForTests:true,debounceMs:5}, () => ['private/flags.inc']);
  try {
    expect(watcher.start()).toBe(true);
    watcher.ingestEventForTests('private/flags.inc');
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toContain('private/flags.inc');
    write('build/units.f','build/top.sv\nbuild/spare.sv\n'); watcher.ingestEventForTests('build/units.f');
    await waitFor(() => calls.length === 2);
    expect(calls[1]).toBeUndefined(); // profile membership needs full HDL reconciliation
    watcher.ingestEventForTests('build/spare.sv'); await waitFor(() => calls.length === 3);
    expect(calls[2]).toContain('build/spare.sv');
    watcher.ingestEventForTests('unrelated/noise.txt'); watcher.ingestEventForTests('.codegraph/graph.db');
    await new Promise(r => setTimeout(r, 30)); expect(calls).toHaveLength(3);
  } finally { watcher.stop(); fs.rmSync(root,{recursive:true,force:true}); }
});

it('retains the last valid HDL watch scope through missing filelists and malformed configuration', () => {
  const {root,write,config} = project(); const scope = new HdlWatchScope(root, () => ['private/flags.inc']);
  try {
    scope.refresh(); expect(scope.matchesDirectory('build')).toBe(true); expect(scope.matchesDirectory('private')).toBe(true);
    fs.unlinkSync(path.join(root,'build/units.f')); scope.refresh(); expect(scope.isFilelist('build/units.f')).toBe(true);
    write('codegraph.json','{'); scope.refresh(); expect(scope.matchesFile('private/flags.inc')).toBe(true);
    write('build/units.f','build/top.sv\n'); write('codegraph.json',config('second')); scope.refresh();
    expect(scope.matchesDirectory('alt/inc/nested')).toBe(true); expect(scope.matchesFile('alt/inc/new.flags')).toBe(true);
    write('codegraph.json','{}'); scope.refresh(); expect(scope.matchesFile('private/flags.inc')).toBe(false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

it('auto-syncs native fs.watch events for ignored filelists, arbitrary-extension includes and newly selected directories', async () => {
  const {root,write,config} = project(); let cg: CodeGraph|undefined; const errors: string[]=[];
  try {
    cg=CodeGraph.initSync(root); expect((await cg.indexAll()).success).toBe(true);
    expect(cg.getNodesByName('top')).toHaveLength(1); expect(cg.getNodesByName('spare')).toHaveLength(0);
    expect(cg.watch({debounceMs:30,onSyncError:e=>errors.push(e.message)})).toBe(true);
    write('build/units.f','build/top.sv\nbuild/spare.sv\n');
    await waitFor(()=>cg!.getNodesByName('spare').length===1);
    write('private/flags.inc','`define EXTRA\n');
    await waitFor(()=>cg!.getNodesByName('extra').length===1);
    write('codegraph.json',config('second'));
    await waitFor(()=>cg!.getNodesByName('other').length===1&&cg!.getNodesByName('top').length===0);
    write('alt/inc/flags.txt','`define SECOND\n');
    await waitFor(()=>cg!.getNodesByName('second').length===1);
    expect(errors).toEqual([]);
    await waitFor(()=>cg!.getHdlProfileStatus()?.state==='matches');
  } finally { cg?.close(); fs.rmSync(root,{recursive:true,force:true}); }
});

it('does not admit reserved or outside paths from untrusted indexed dependency metadata', () => {
  const {root} = project();
  const scope = new HdlWatchScope(root, () => ['../outside/flags.inc','.codegraph-other/flags.inc','vendor/.git/config','.jj/state','private/flags.inc',123] as string[]);
  try {
    scope.refresh();
    expect(scope.matchesFile('private/flags.inc')).toBe(true);
    expect(scope.matchesDirectory('outside')).toBe(false);
    expect(scope.matchesDirectory('.codegraph-other')).toBe(false);
    expect(scope.matchesFile('vendor/.git/config')).toBe(false);
    expect(scope.matchesDirectory('.jj')).toBe(false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
