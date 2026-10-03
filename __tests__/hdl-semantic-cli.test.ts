import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import CodeGraph from '../src/index';

it.skipIf(process.platform === 'win32')('compiled hdl-semantic CLI passes explicit overrides and rejects duplicate/invalid options', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-semantic-cli-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const tool = path.join(temp, 'fake-slang');
  fs.writeFileSync(tool, `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),python=a[0]==='-I';
if(a.includes('--version')) console.log(python?'codegraph pyslang 11.0.0 exporter 1 native '+'a'.repeat(64):'slang version 11.0.448');
else {
  const override=a[a.indexOf('-G')+1],value=override?.startsWith('W=')?override.slice(2):'8';
  const output=python?{codegraphSemanticVersion:1,facts:[{kind:'parameter',name:'W',instancePath:'top',value,sourceOrigin:'direct',source:{file:'top.sv',line:1,column:24}}]}:
    {design:{kind:'Root',members:[{kind:'Instance',name:'top',body:{kind:'InstanceBody',members:[{kind:'Parameter',name:'W',value,type:{kind:'PredefinedIntegerType',name:'int'},source_file:'top.sv',source_line:1,source_column:24}]}}]}};
  fs.writeFileSync(a[a.indexOf('--ast-json')+1],JSON.stringify(output));
}
`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'top.sv'), 'module top #(parameter W=8)(); endmodule\n');
  fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ hdl: { activeProfile: 'synth', profiles: {
    synth: { files: ['top.sv'], topModules: ['top'] },
  } } }));
  const bin = path.resolve(__dirname, '../dist/bin/codegraph.js');
  const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_SEMANTIC_TMPDIR: path.join(temp, 'snapshots'), NO_COLOR: '1' },
  });
  try {
    CodeGraph.initSync(root).close();
    const indexed = run(['index', root, '--quiet']); expect(indexed.status, indexed.stderr).toBe(0);
    const result = run(['hdl-semantic', 'top.W', '--path', root, '--slang', tool, '--parameter', 'W=16']);
    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.provenance.parameters).toEqual({ W: '16' });
    expect(body.provenance.compilationUnitMode).toBe('separate');
    expect(body.facts[0]).toMatchObject({ name: 'W', value: '16' });
    expect(body.facts[0].sourceNodeId).toBeTruthy();
    const mapped = run(['hdl-semantic', 'W', '--path', root, '--python', tool, '--parameter', 'W=12']);
    expect(mapped.status, mapped.stderr).toBe(0);
    expect(JSON.parse(mapped.stdout).provenance.frontend).toBe('pyslang');
    expect(JSON.parse(mapped.stdout).facts[0]).toMatchObject({ value: '12', sourceOrigin: 'direct' });
    const dual = run(['hdl-semantic', '--path', root, '--slang', tool, '--python', tool]);
    expect(dual.status).toBe(1); expect(dual.stderr).toContain('exactly one');
    const duplicate = run(['hdl-semantic', '--path', root, '--slang', tool, '--parameter', 'W=1', 'W=2']);
    expect(duplicate.status).toBe(1); expect(duplicate.stderr).toContain('Duplicate HDL parameter');
    const invalid = run(['hdl-semantic', '--path', root, '--slang', tool, '--limit', '1junk']);
    expect(invalid.status).toBe(1); expect(invalid.stderr).toContain('1..1000');
    expect(fs.readdirSync(path.join(temp, 'snapshots'))).toHaveLength(0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
