import { it, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
import * as os from 'node:os';
import * as path from 'node:path';
const { readBoundedSource, readBoundedSourceSync, MAX_SOURCE_FILE_SIZE_BYTES: LIMIT } = require('../dist/file-limits.js');
const dirs:string[]=[];
function file(bytes:Buffer){const d=fs.mkdtempSync(path.join(os.tmpdir(),'cg-bounded-'));dirs.push(d);const f=path.join(d,'source.ts');fs.writeFileSync(f,bytes);return f;}
afterEach(()=>{vi.restoreAllMocks();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
for(const size of [0,100,LIMIT,LIMIT+1]) it(`bounds sync and async reads at ${size} bytes`,async()=>{
 const f=file(Buffer.alloc(size,0x61));
 for(const result of [readBoundedSourceSync(f),await readBoundedSource(f)]) {expect(result.stats.size).toBe(size);if(size>LIMIT)expect(result.bytes).toBeNull();else expect(result.bytes?.length).toBe(size);}
});
it('bounds data that grows during synchronous reading',()=>{
 const f=file(Buffer.from('hello'));const original=fs.readSync;let requested=0,grown=false;
 vi.spyOn(fs,'readSync').mockImplementation(((fd:any,b:any,o:any,n:any,p:any)=>{requested+=n;if(!grown){grown=true;fs.writeFileSync(f,Buffer.alloc(LIMIT+10,0x61));}return original(fd,b,o,n,p);}) as any);
 const result=readBoundedSourceSync(f);expect(grown).toBe(true);expect(requested).toBeLessThanOrEqual(LIMIT+1);expect(result.bytes).toBeNull();
});
it('rechecks the descriptor after an asynchronous stat/open race',async()=>{
 const f=file(Buffer.from('hello'));const original=fsp.open;let grown=false;
 vi.spyOn(fsp,'open').mockImplementation((async(...args:any[])=>{grown=true;fs.writeFileSync(f,Buffer.alloc(LIMIT+1));return (original as any)(...args);}) as any);
 expect((await readBoundedSource(f)).bytes).toBeNull();expect(grown).toBe(true);
});
it('does not decode or alter multibyte source',async()=>{
 const text='export const greeting = "こんにちは 🌿";';const f=file(Buffer.from(text));expect((await readBoundedSource(f)).bytes?.toString('utf8')).toBe(text);expect(readBoundedSourceSync(f).bytes?.toString('utf8')).toBe(text);
});
