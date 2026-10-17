import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { dispatchWorkbench } from '../src/ui-server/api/workbench';
import { buildMap } from '../src/ui-server/api/map';
import type { Node } from '../src/types';
let root: string, cg: CodeGraph, db: DatabaseConnection, q: QueryBuilder;
const n = (id: string): Node => ({id,name:id,kind:'function',qualifiedName:id,filePath:'src/a.ts',language:'typescript',startLine:1,endLine:1,startColumn:0,endColumn:0,updatedAt:1});
beforeEach(() => {root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-wb-api-'));cg=CodeGraph.initSync(root);db=DatabaseConnection.open(getDatabasePath(root));q=new QueryBuilder(db.getDb());});
afterEach(()=>{db.close();cg.close();fs.rmSync(root,{recursive:true,force:true});});
describe('工作台API边界',()=>{
  it('分页游标绑定查询和数据库版本',()=>{
    q.insertNodes([n('hub'),n('peer')]);q.insertEdges(Array.from({length:4},(_,i)=>({source:'hub',target:'peer',kind:'calls' as const,line:i+1})));
    const query=new URLSearchParams('id=hub&direction=out&limit=2');
    const first=dispatchWorkbench(cg,root,'/api/neighbors',query) as any;
    expect(first.items).toHaveLength(2);expect(first.nextCursor).toBeTypeOf('string');
    query.set('cursor',first.nextCursor);
    const second=dispatchWorkbench(cg,root,'/api/neighbors',query) as any;
    expect(second.items.map((v:any)=>v.edge.line)).toEqual([3,4]);expect(second.nextCursor).toBeNull();
    query.set('direction','in');expect(()=>dispatchWorkbench(cg,root,'/api/neighbors',query)).toThrow(/游标/);
    query.set('direction','out');q.insertNodes([n('new')]);expect(()=>dispatchWorkbench(cg,root,'/api/neighbors',query)).toThrow(/索引/);
  });
  it('地图节点超预算返回范围而不返回完整图',()=>{
    for(let i=0;i<405;i++) q.upsertFile({path:`src/m${i}/a.ts`,language:'typescript',contentHash:'x',size:1,modifiedAt:1,indexedAt:1,nodeCount:1});
    const result=buildMap(cg,root,new URLSearchParams('root=src&depth=1&bounded=1')) as any;
    expect(result.budget.exceeded).toBe(true);expect(result.budget.nodes).toBe(405);expect(result.modules).toEqual([]);expect(result.links).toEqual([]);expect(result.roots.length).toBeGreaterThan(0);
  });
  it('局部文件循环按需加载，测试过滤在模块预算前执行',()=>{
    for(const file of ['src/a/a.ts','src/b/b.ts']) { q.upsertFile({path:file,language:'typescript',contentHash:'x',size:1,modifiedAt:1,indexedAt:1,nodeCount:1});q.insertNodes([{...n(file),filePath:file}]); }
    q.insertEdges([{source:'src/a/a.ts',target:'src/b/b.ts',kind:'calls'},{source:'src/b/b.ts',target:'src/a/a.ts',kind:'calls'}]);
    const result=buildMap(cg,root,new URLSearchParams('root=src&bounded=1&details=1'));
    expect(result.cycles.total).toBe(1);expect(result.detailsDeferred).toBe(false);
    for(let i=0;i<405;i++) q.upsertFile({path:`src/test${i}/unit.test.ts`,language:'typescript',contentHash:'x',size:1,modifiedAt:1,indexedAt:1,nodeCount:1});
    const filtered=buildMap(cg,root,new URLSearchParams('root=src&bounded=1&tests=0&minWeight=3'));
    expect(filtered.budget?.exceeded).toBe(false);expect(filtered.modules).toHaveLength(2);expect(filtered.links).toHaveLength(0);
  });
  it('目录与文件分页不会读取相邻前缀或跳出项目',()=>{
    for(const file of ['src/game/a.ts','src/game/b.ts','src/game/sub/c.ts','src/game2/leak.ts']) q.upsertFile({path:file,language:'typescript',contentHash:'x',size:1,modifiedAt:1,indexedAt:1,nodeCount:1});
    const page=dispatchWorkbench(cg,root,'/api/browse',new URLSearchParams('root=src/game&kind=files&limit=1')) as any;
    expect(page.items[0].path).toBe('src/game/a.ts');
    const next=dispatchWorkbench(cg,root,'/api/browse',new URLSearchParams({root:'src/game',kind:'files',limit:'1',cursor:page.nextCursor})) as any;
    expect(next.items[0].path).toBe('src/game/b.ts');expect(next.nextCursor).toBeNull();
    expect(()=>dispatchWorkbench(cg,root,'/api/browse',new URLSearchParams('root=../x'))).toThrow();
  });
});


it.each([false, true])('upstream compact module labels retain Pinable test filtering (bounded=%s)', (bounded) => {
  const prefix = 'src/main/java/org/example/app';
  const files = [`${prefix}/App.ts`, `${prefix}/core/a.ts`, `${prefix}/services/b.ts`];
  for (const file of files) {
    q.upsertFile({ path: file, language: 'typescript', contentHash: 'x', size: 1,
      modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
    q.insertNodes([{ ...n(file), filePath: file }]);
  }
  q.insertEdges([{ source: files[1]!, target: files[2]!, kind: 'calls', confidence: 1 }]);
  for (let i = 0; i < 405; i++) {
    q.upsertFile({ path: `src/tests/group${i}/unit.test.ts`, language: 'typescript',
      contentHash: 'test', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
  }
  const result = buildMap(cg, root, new URLSearchParams({
    root: 'src', depth: '2', tests: '0', bounded: bounded ? '1' : '0',
  }));
  expect(result.budget?.exceeded).not.toBe(true);
  expect(result.modules.map(module => module.id).sort()).toEqual([
    `${prefix}/(root files)`, `${prefix}/core`, `${prefix}/services`,
  ].sort());
  expect(result.modules.find(module => module.id === `${prefix}/core`)?.label)
    .toBe('src/main/…/app/core');
  expect(result.modules.every(module => !module.test)).toBe(true);
  expect(result.links).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: `${prefix}/core`, target: `${prefix}/services`, count: 1 }),
  ]));
  const withTests = buildMap(cg, root, new URLSearchParams('root=src&depth=2&tests=1&bounded=1'));
  expect(withTests.budget?.exceeded).toBe(true);
});
