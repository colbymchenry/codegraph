import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('.build/',import.meta.url),{recursive:true});
for (const file of ['worker.ts','test-worker.ts']) await build({entryPoints:[file],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'.build/'+file.replace('.ts','.js'),metafile:true}).then(async result=>{
  const {writeFile}=await import('node:fs/promises');await writeFile('.build/'+file+'.meta.json',JSON.stringify(result.metafile,null,2));
});
