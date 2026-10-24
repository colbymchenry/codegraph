import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { loadHdlProfile } from '../src/hdl/profile';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../src/hdl/semantic-runner', () => ({ runSlangSemantics: run }));

let root: string;
let cg: CodeGraph;
const source = 'module top #(parameter W = 8)(input logic [W-1:0] data);\nendmodule\n';
function ast(width = 8, column: number = 24) {
  return { design: { kind: 'Root', name: '$root', members: [{ kind: 'Instance', name: 'top', body: {
    kind: 'InstanceBody', name: 'top', members: [
      { kind: 'Parameter', name: 'W', value: String(width), type: { kind: 'PredefinedIntegerType', name: 'int' },
        source_file: path.join(root, 'top.sv'), source_line: 1, source_column: column },
      { kind: 'Port', name: 'data', type: { kind: 'PackedArrayType', range: `[${width - 1}:0]`, elementType: { kind: 'ScalarType', name: 'logic' } },
        direction: 'In', source_file: path.join(root, 'top.sv'), source_line: 1, source_column: 49 },
    ],
  } }] } };
}
function result(value = ast()) {
  return { ast: value, sourceRoot: root, profileName: 'synth', configurationFingerprint: loadHdlProfile(root).profile!.fingerprint,
    fingerprint: 'semantic-snapshot', version: 'slang version 11.0.448', executableSha256: 'executable-hash',
    sources: { 'top.sv': source }, top: 'top', diagnostics: [], parameters: {}, allowUseBeforeDeclare: false };
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-semantics-'));
  fs.writeFileSync(path.join(root, 'top.sv'), source);
  fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ hdl: { activeProfile: 'synth', profiles: {
    synth: { files: ['top.sv'], topModules: ['top'] },
  } } }));
  cg = await CodeGraph.init(root, { index: true });
  run.mockResolvedValue(result());
});
afterEach(() => { cg?.close(); fs.rmSync(root, { recursive: true, force: true }); run.mockReset(); });

describe('on-demand HDL semantics on the source graph', () => {
  it('returns computed facts and links the matching source declaration', async () => {
    const value = await cg.getHdlSemantics({ executable: 'slang', query: 'top.W' });
    expect(value.sourceGraphProfileMatches).toBe(true);
    expect(value.facts).toHaveLength(1);
    expect(value.facts[0]).toMatchObject({ name: 'W', value: '8', sourceNodeId: cg.getNodesByName('W')[0].id });
    expect(value.provenance.top).toBe('top');
  });
  it('does not link an index from another profile or different source bytes', async () => {
    const changed = result(); changed.configurationFingerprint = 'different-profile';
    run.mockResolvedValue(changed);
    expect((await cg.getHdlSemantics({ executable: 'slang' })).facts.every(f => !f.sourceNodeId)).toBe(true);
    run.mockResolvedValue({ ...result(), sources: { 'top.sv': source.replace('8', '9') } });
    expect((await cg.getHdlSemantics({ executable: 'slang' })).facts.every(f => !f.sourceNodeId)).toBe(true);
  });
  it('preserves unknown macro columns, exact queries and truncation', async () => {
    run.mockResolvedValue(result(ast(8, 0)));
    const value = await cg.getHdlSemantics({ executable: 'slang', query: 'top', limit: 1 });
    expect(value.totalMatches).toBe(2); expect(value.truncated).toBe(true);
    expect(value.facts[0].source?.column).toBeNull(); expect(value.facts[0].sourceNodeId).toBeUndefined();
    expect((await cg.getHdlSemantics({ executable: 'slang', query: 'missing' })).facts).toHaveLength(0);
    await expect(cg.getHdlSemantics({ executable: 'slang', limit: 0 })).rejects.toThrow('1..1000');
  });
  it('recomputes overrides and keeps source graph after compiler failure', async () => {
    run.mockResolvedValue(result(ast(12)));
    expect((await cg.getHdlSemantics({ executable: 'slang', parameters: { W: '12' }, query: 'W' })).facts[0].value).toBe('12');
    expect(run.mock.calls[0][1].parameters).toEqual({ W: '12' });
    const before = cg.getNodesByName('W');
    run.mockRejectedValue(new Error('slang unavailable'));
    await expect(cg.getHdlSemantics({ executable: 'missing' })).rejects.toThrow('unavailable');
    expect(cg.getNodesByName('W')).toEqual(before);
    expect(cg.getHdlProfileStatus()?.state).toBe('matches');
  });
});
