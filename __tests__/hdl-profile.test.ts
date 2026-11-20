import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadHdlProfile } from '../src/hdl/profile';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-profile-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}
function config(profile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  write('codegraph.json', JSON.stringify({ ...extra, hdl: { activeProfile: 'synth', profiles: { synth: profile } } }));
}
function active() {
  const result = loadHdlProfile(root);
  expect(result.status, result.diagnostics.join('\n')).toBe('active');
  return result.profile!;
}

it('preserves no-HDL legacy behavior and reports malformed overall JSON separately', () => {
  expect(loadHdlProfile(root)).toMatchObject({ status: 'none', profile: null, configPresent: false });
  write('codegraph.json', JSON.stringify({ exclude: ['cache'] }));
  expect(loadHdlProfile(root)).toMatchObject({ status: 'none', configPresent: true });
  write('codegraph.json', '{');
  expect(loadHdlProfile(root)).toMatchObject({ status: 'invalid-config', configInvalid: true, profile: null });
});

it('loads explicit files in order with root-relative canonical identity and no implicit includes as source files', () => {
  write('rtl/a.sv', 'module a; endmodule'); write('rtl/b.v', 'module b; endmodule'); write('inc/defs.svh', '`define W 2');
  config({ files: ['rtl/b.v', './rtl/a.sv', 'rtl/b.v'], includeDirs: ['inc'], defines: { SYNTHESIS: '1' }, topModules: ['a'], languageMode: 'systemverilog' });
  expect(active()).toMatchObject({ name: 'synth', files: ['rtl/b.v', 'rtl/a.sv'], includeDirs: ['inc'], defines: { SYNTHESIS: '1' }, topModules: ['a'], languageMode: 'systemverilog', dependencies: [] });
});

it('treats an explicitly empty profile as an empty design', () => {
  write('unrelated.sv', 'module unrelated; endmodule'); config({ files: [] });
  expect(active().files).toEqual([]);
});

it('handles nested -f/-F bases, quotes, comments and multiple include/define entries without executing anything', () => {
  write('rtl/a.sv', 'module a; endmodule'); write('lists/local file.sv', 'module local_file; endmodule');
  write('inc one/defs.svh', ''); write('inc+two/defs.svh', '');
  write('root.f', '// comment\n+incdir+"inc one"+"inc+two"\n+define+ONE+BITS=1\'b1+TEXT="a+b c"\n-f lists/rootpaths.f\n-F lists/local.F\n');
  write('lists/rootpaths.f', '# comment\nrtl/a.sv /* end comment */\n');
  write('lists/local.F', '"local file.sv"\n');
  config({ files: [], filelists: ['root.f'] });
  const p = active();
  expect(p.files).toEqual(['rtl/a.sv', 'lists/local file.sv']);
  expect(p.includeDirs).toEqual(['inc one', 'inc+two']);
  expect(p.defines).toEqual({ ONE: '1', BITS: "1'b1", TEXT: 'a+b c' });
  expect(p.dependencies.map(d => d.path)).toEqual(['lists/local.F', 'lists/rootpaths.f', 'root.f']);
  expect(p.dependencies.every(d => /^[a-f0-9]{64}$/.test(d.sha256))).toBe(true);
});

it('uses top-level .F paths relative to that list and rejects source paths missing under -f root semantics', () => {
  write('lists/only.sv', 'module only; endmodule'); write('lists/relative.F', 'only.sv');
  config({ filelists: ['lists/relative.F'] }); expect(active().files).toEqual(['lists/only.sv']);
  write('lists/root.f', 'only.sv'); config({ filelists: ['lists/root.f'] });
  expect(loadHdlProfile(root).status).toBe('invalid-profile');
});

it.each([
  { files: 'rtl/a.sv' }, { files: [], unexpected: true }, { files: [], defines: { FLAG: true } },
  { files: [], languageMode: 'vhdl' }, { files: ['missing.sv'] },
])('rejects invalid recognized HDL profiles instead of scanning everything: %j', profile => {
  config(profile); expect(loadHdlProfile(root)).toMatchObject({ status: 'invalid-profile', profile: null, configInvalid: false });
});

it.each(['-sv rtl/a.sv', '+libext+.v', '-f', '+incdir+', '+define+', '"unfinished', '/* unfinished'])('rejects unsupported/malformed filelist syntax: %s', text => {
  write('list.f', text); config({ filelists: ['list.f'] });
  expect(loadHdlProfile(root)).toMatchObject({ status: 'invalid-profile', profile: null });
});

it('rejects recursive filelists, conflicting defines and external/symlink escapes', () => {
  write('a.f', '-f b.f'); write('b.f', '-f a.f'); config({ filelists: ['a.f'] });
  expect(loadHdlProfile(root).diagnostics.join()).toContain('cycle');
  write('a.f', '+define+FLAG=2'); config({ filelists: ['a.f'], defines: { FLAG: '1' } });
  expect(loadHdlProfile(root).diagnostics.join()).toContain('Conflicting');
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-profile-external-'));
  try {
    fs.writeFileSync(path.join(external, 'foreign.sv'), 'module foreign; endmodule');
    config({ files: [path.join(external, 'foreign.sv')] });
    expect(loadHdlProfile(root).diagnostics.join()).toContain('outside');
    fs.symlinkSync(external, path.join(root, 'escape'), 'dir'); config({ includeDirs: ['escape'], files: [] });
    expect(loadHdlProfile(root).diagnostics.join()).toContain('outside');
  } finally { fs.rmSync(external, { recursive: true, force: true }); }
});

it('fingerprints profile switching, filelist content and include configuration, preserving inactive/whitespace changes', () => {
  write('a.sv', 'module a; endmodule'); write('src.f', 'a.sv\n'); write('inc/defs.svh', ''); write('alt/defs.svh', '');
  const cfg = { hdl: { activeProfile: 'synth', profiles: { synth: { filelists: ['src.f'], includeDirs: ['inc'] }, sim: { files: ['a.sv'] } } } };
  write('codegraph.json', JSON.stringify(cfg)); const a = active().fingerprint;
  write('codegraph.json', JSON.stringify(cfg, null, 4)); expect(active().fingerprint).toBe(a);
  cfg.hdl.profiles.sim.files = []; write('codegraph.json', JSON.stringify(cfg)); expect(active().fingerprint).toBe(a);
  write('src.f', '// dependency edit\na.sv\n'); const b = active().fingerprint; expect(b).not.toBe(a);
  cfg.hdl.profiles.synth.includeDirs = ['alt']; write('codegraph.json', JSON.stringify(cfg)); const c = active().fingerprint; expect(c).not.toBe(b);
  cfg.hdl.activeProfile = 'sim'; write('codegraph.json', JSON.stringify(cfg)); expect(active().fingerprint).not.toBe(c); expect(active().files).toEqual([]);
});

it('enforces filelist resource limits', () => {
  write('huge.f', ' '.repeat(1024 * 1024 + 1)); config({ filelists: ['huge.f'] });
  expect(loadHdlProfile(root).diagnostics.join()).toContain('1 MiB');
});

it('rejects reserved VCS and CodeGraph files and include directories before indexing', () => {
  write('.git/units.f',''); write('.codegraph-alt/unit.sv','module unit; endmodule'); write('.jj/headers/a.svh','');
  for (const profile of [{filelists:['.git/units.f']},{files:['.codegraph-alt/unit.sv']},{files:[],includeDirs:['.jj/headers']}]) {
    config(profile); expect(loadHdlProfile(root).status).toBe('invalid-profile');
    expect(loadHdlProfile(root).diagnostics.join()).toContain('Reserved');
  }
});

it('rejects ordinary aliases resolving into reserved CodeGraph paths', () => {
  write('.codegraph-cache/unit.sv','module unit; endmodule');
  fs.symlinkSync(path.join(root,'.codegraph-cache'),path.join(root,'alias'),'dir');
  config({files:['alias/unit.sv']}); expect(loadHdlProfile(root).diagnostics.join()).toContain('Reserved');
});
