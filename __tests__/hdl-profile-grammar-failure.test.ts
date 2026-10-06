/**
 * An HDL profile change re-indexes every profile source, since the same bytes
 * parse differently under other defines. If the Verilog grammar cannot be
 * loaded during that sync, nothing is stored for those files (#2335) — so the
 * index must not record the new profile as indexed either, or no later sync
 * would revisit files whose size, mtime and hash all still match.
 */
import { it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import type { Language } from '../src/types';

const { failing } = vi.hoisted(() => ({ failing: new Set<string>() }));

vi.mock('../src/extraction/grammars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/extraction/grammars')>();
  return {
    ...actual,
    getParser: (language: Language) => (failing.has(language) ? null : actual.getParser(language)),
  };
});

it('a profile switch whose sources could not be parsed stays pending until they are', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-profile-grammar-'));
  let cg: CodeGraph | undefined;
  const config = (activeProfile: string) => JSON.stringify({ hdl: { activeProfile, profiles: {
    synth: { files: ['top.sv'], defines: { SYNTHESIS: '1' } },
    sim: { files: ['top.sv'] },
  } } });
  const functions = () => cg!.getNodesInFile('top.sv').filter((n) => n.kind === 'function').map((n) => n.name);
  try {
    fs.writeFileSync(path.join(root, 'top.sv'),
      'module top;\n`ifdef SYNTHESIS\nfunction int hardware(); return 1; endfunction\n`else\nfunction int software(); return 2; endfunction\n`endif\nendmodule\n');
    fs.writeFileSync(path.join(root, 'codegraph.json'), config('synth'));
    cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
    expect(functions()).toEqual(['hardware']);

    fs.writeFileSync(path.join(root, 'codegraph.json'), config('sim'));
    failing.add('verilog');
    await cg.sync();
    expect(functions()).toEqual(['hardware']);
    expect(cg.getHdlProfileStatus()?.state).toBe('mismatch');

    failing.clear();
    await cg.sync();
    expect(functions()).toEqual(['software']);
    expect(cg.getHdlProfileStatus()?.state).toBe('matches');
  } finally {
    failing.clear();
    cg?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
