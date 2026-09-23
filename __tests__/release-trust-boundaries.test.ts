import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const { CodeGraph } = require('../dist/index.js');
const { ToolHandler } = require('../dist/mcp/tools.js');
it('documents that explicit projectPath can query a second indexed repository', async () => {
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cg-cross-project-'));
 const a=path.join(temp,'a'),b=path.join(temp,'b');fs.mkdirSync(a);fs.mkdirSync(b);
 fs.writeFileSync(path.join(a,'a.py'),'def local_marker():\n    return 1\n');
 fs.writeFileSync(path.join(b,'b.py'),'def other_repo_marker():\n    return 2\n');
 let cg:any;let handler:any;
 try {
  const other=await CodeGraph.init(b,{index:true});other.close();cg=await CodeGraph.init(a,{index:true});handler=new ToolHandler(cg);
  const local=await handler.execute('codegraph_search',{query:'other_repo_marker'});
  expect(local.content[0].text).not.toContain('b.py');
  const remote=await handler.execute('codegraph_search',{query:'other_repo_marker',projectPath:b});
  expect(remote.isError, JSON.stringify(remote)).toBeFalsy();expect(remote.content[0].text).toContain('other_repo_marker');expect(remote.content[0].text).toContain('b.py');
 }finally{handler?.closeAll();cg?.close();fs.rmSync(temp,{recursive:true,force:true});}
});
