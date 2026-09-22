import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {makePlan,validatePlan,validateTarget,importOfficial,hash} from './official.mjs';
const require=createRequire(import.meta.url),engineVersion=require('../../package.json').version;
const [action,...args]=process.argv.slice(2);
async function main() {
  if(action==='inspect-local'&&args.length===1) {
    const state=path.resolve(args[0]);if(!fs.existsSync(state))throw Error('Local state does not exist');
    const {startLocal}=await import('./local.mjs');const server=await startLocal({state,initialize:false});
    try {console.log(JSON.stringify({mode:'local',state,registryId:await server.db.prepare("SELECT value FROM registry_meta WHERE key='id'").first('value'),engineVersion},null,2));}finally{await server.close();}return;
  }
  if(action==='plan'&&args.length===3) {
    const [targetPath,artifactPath,out]=args,artifact=path.resolve(artifactPath);
    const plan=makePlan(fs.readFileSync(artifact),JSON.parse(fs.readFileSync(targetPath,'utf8')),artifact);
    fs.writeFileSync(out,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({action:'review-plan',path:path.resolve(out),sha256:hash(fs.readFileSync(out)),target:plan.target,id:plan.listing.id,version:plan.listing.version,integrity:plan.listing.integrity}));return;
  }
  if(action==='apply'&&args.length===3&&args[1]==='--confirm-plan-sha256') {
    const raw=fs.readFileSync(args[0]);if(!/^[a-f0-9]{64}$/.test(args[2])||hash(raw)!==args[2])throw Error('Review the exact plan and confirm its SHA-256 before applying');
    const plan=JSON.parse(raw),bytes=fs.readFileSync(plan.artifact);validatePlan(plan,bytes);validateTarget(plan.target);
    if(plan.target.mode==='local') {
      const {startLocal}=await import('./local.mjs');const server=await startLocal({state:plan.target.state,initialize:false});
      try {console.log(JSON.stringify(await importOfficial(server.db,server.bucket,plan,bytes)));}finally{await server.close();}
    } else {
      const {remoteBindings}=await import('./official-remote.mjs');
      const bindings=remoteBindings(plan.target,{d1Token:process.env.CLOUDFLARE_API_TOKEN,r2AccessKeyId:process.env.CODEGRAPH_R2_ACCESS_KEY_ID,r2SecretAccessKey:process.env.CODEGRAPH_R2_SECRET_ACCESS_KEY});
      console.log(JSON.stringify(await importOfficial(bindings.db,bindings.bucket,plan,bytes)));
    }
    return;
  }
  throw Error('Usage: official-cli.mjs inspect-local STATE | plan TARGET.json ARTIFACT.cgext NEW_PLAN.json | apply PLAN.json --confirm-plan-sha256 HASH');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
