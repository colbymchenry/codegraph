import { describe, expect, it } from 'vitest';
import { parsePackage, MAX_PACKAGE_BYTES } from '../src/plugins/package-validation';
const fixture = () => ({format:'codegraph-extension-1',package:{name:'test',version:'1.0.0',main:'index.cjs',codegraph:{id:'portable',apiVersion:1,engines:'>=1.6 <2',capabilities:['frameworks']}},files:{'index.cjs':'module.exports=()=>({frameworks:[]});'} as Record<string,string>});
const bytes = (p: unknown) => new TextEncoder().encode(JSON.stringify(p));
describe('portable registry and installer package contract', () => {
  it('validates a plain byte array with the actual engine constraint', () => {
    expect(parsePackage(bytes(fixture()),'1.6.0').package.codegraph.id).toBe('portable');
    expect(()=>parsePackage(bytes(fixture()),'2.0.0')).toThrow('requires CodeGraph');
  });
  it('preserves the Node parser rejection of a leading UTF-8 BOM', () => {
    expect(()=>parsePackage(new Uint8Array([239,187,191,...bytes(fixture())]))).toThrow();
  });
  it('accepts exactly 8 MiB and rejects the next byte', () => {
    const p=fixture();p.files['padding.txt']='';p.files['padding.txt']='x'.repeat(MAX_PACKAGE_BYTES-bytes(p).length);
    const value=bytes(p);expect(value.length).toBe(MAX_PACKAGE_BYTES);expect(parsePackage(value).package.version).toBe('1.0.0');
    const oversized=new Uint8Array(MAX_PACKAGE_BYTES+1);oversized.set(value);oversized[MAX_PACKAGE_BYTES]=32;
    expect(()=>parsePackage(oversized)).toThrow('exceeds 8 MiB');
  });
  it('rejects unsafe paths and unsupported API before execution', () => {
    const p=fixture();p.files['../escape.cjs']='throw Error("must not execute")';expect(()=>parsePackage(bytes(p))).toThrow('unsafe path');
    delete p.files['../escape.cjs'];p.package.codegraph.apiVersion=9;expect(()=>parsePackage(bytes(p))).toThrow('unsupported API version');
  });
});
