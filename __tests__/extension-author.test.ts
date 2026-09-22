import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Public package surface only. Authors must not need private loader imports.
import { createExtensionProject, defineExtension, EXTENSION_API_VERSION, packExtension, testExtension, type CodeGraphPlugin } from '../src';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function starter(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-author-tests-'));
  roots.push(root);
  const author = path.join(root, 'author');
  createExtensionProject(author, 'python-events');
  return author;
}
function changeJSON(root: string, file: string, change: (data: any) => void): void {
  const target = path.join(root, file), data = JSON.parse(fs.readFileSync(target, 'utf8'));
  change(data); fs.writeFileSync(target, JSON.stringify(data));
}

describe('external extension author kit', () => {
  it('generates and tests a second framework using only public API, including negative graph expectations and removal', async () => {
    expect(EXTENSION_API_VERSION).toBe(1);
    const factory: CodeGraphPlugin = () => ({ frameworks: [] });
    expect(defineExtension(factory)).toBe(factory);
    const author = starter();
    expect(fs.readFileSync(path.join(author, 'index.cjs'), 'utf8')).not.toMatch(/require\(|\/src\/|\/dist\//);
    const report = await testExtension(author);
    expect(report.cases).toHaveLength(2);
    expect(report.cases.every(c => c.deterministic && c.removalClean)).toBe(true);
    expect(report.cases.reduce((sum, c) => sum + c.assertions, 0)).toBe(8);
    expect(packExtension(author)).toEqual(packExtension(author));
  }, 90_000);

  it('does not overwrite existing author work and rejects malformed IDs', () => {
    const author = starter(), before = fs.readFileSync(path.join(author, 'index.cjs'));
    expect(() => createExtensionProject(author, 'other')).toThrow(/EEXIST/);
    expect(fs.readFileSync(path.join(author, 'index.cjs'))).toEqual(before);
    expect(() => createExtensionProject(path.join(author, 'bad'), '../escape')).toThrow(/manifest/);
    expect(fs.existsSync(path.join(author, 'bad'))).toBe(false);
  });

  it('reports API and engine compatibility before evaluating author code', async () => {
    const author = starter();
    fs.writeFileSync(path.join(author, 'index.cjs'), "throw new Error('MUST NOT EVALUATE')");
    changeJSON(author, 'package.json', p => { p.codegraph.apiVersion = 99; });
    await expect(testExtension(author)).rejects.toThrow(/unsupported API version 99.*supports 1/);
    changeJSON(author, 'package.json', p => { p.codegraph.apiVersion = 1; p.codegraph.engines = '>=999'; });
    await expect(testExtension(author)).rejects.toThrow(/requires CodeGraph >=999.*running/);
    changeJSON(author, 'package.json', p => { delete p.codegraph.id; });
    expect(() => packExtension(author)).toThrow(/codegraph.id/);
  });

  it.each([
    ["module.exports=()=>({frameworks:[{name:'bad',detect:()=>true,resolve:()=>null,extract:()=>({nodes:42,references:[]})}]})", /extract must return/],
    ["module.exports=()=>({frameworks:[{name:'bad',detect:()=>true,resolve:()=>null,extract:()=>({nodes:[{id:'not-owned'}],references:[]})}]})", /Invalid contributed node: use a plugin:python-events:/],
    ["module.exports=()=>({synthPasses:[{name:'bad',async run(graph){const n=graph.getNodesByName('send_receipt')[0];return [{source:n.id,target:n.id,kind:'calls'}]}}]})", /missing label.*metadata.label/],
  ])('reports malformed author output with the failing case and contract requirement', async (source, message) => {
    const author = starter();
    changeJSON(author, 'package.json', p => { p.codegraph.capabilities = ['frameworks', 'synthPasses']; });
    fs.writeFileSync(path.join(author, 'index.cjs'), source);
    await expect(testExtension(author)).rejects.toThrow(message);
  }, 90_000);

  it('fails useful graph assertions instead of accepting an extension that emits nothing', async () => {
    const author = starter();
    fs.writeFileSync(path.join(author, 'index.cjs'), 'module.exports=()=>({frameworks:[]})');
    await expect(testExtension(author)).rejects.toThrow(/Author case.*Missing contributed node/);
  }, 90_000);

  it('rejects vacuous expectations, traversal and reserved project configuration before executing code', async () => {
    const author = starter();
    for (const file of ['../outside.py', '.codegraph/codegraph.db', 'package.json', 'codegraph.json']) {
      changeJSON(author, 'extension.test.json', p => { p.cases[0].files = { [file]: 'bad' }; });
      await expect(testExtension(author)).rejects.toThrow(/unsafe or reserved/);
    }
    changeJSON(author, 'extension.test.json', p => { p.cases[0].files = { 'app.py': 'pass' }; p.cases[0].expect = {}; });
    await expect(testExtension(author)).rejects.toThrow(/at least one graph assertion/);
  });
});
