// Local Worker-runtime operator rehearsal. Production remote backup steps are in the guide.
import path from 'node:path';
import fs from 'node:fs';
import {startLocal} from './local.mjs';
import {backupRegistry,restoreRegistry} from './backup.mjs';
const [action,stateArg,backupArg]=process.argv.slice(2);
if(!['serve','backup','restore'].includes(action)||!stateArg||(['backup','restore'].includes(action)&&!backupArg))throw Error('Usage: node ops.mjs serve|backup|restore ABSOLUTE_STATE [ABSOLUTE_BACKUP]');
if(!path.isAbsolute(stateArg)||(backupArg&&!path.isAbsolute(backupArg)))throw Error('Use explicit absolute state and backup paths');
if(action==='backup'&&!fs.existsSync(stateArg))throw Error('Source state directory does not exist');
if(action==='restore'&&fs.existsSync(stateArg))throw Error('Restore requires a new state directory');
const server=await startLocal({state:stateArg,publishing:action==='serve',initialize:action!=='backup'});
if(action==='serve'){
  console.log(JSON.stringify({local:true,origin:'http://127.0.0.1:'+server.port,state:stateArg}));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await server.close();process.exit(0);});
}else try{
  console.log(JSON.stringify(await (action==='backup'?backupRegistry:restoreRegistry)(server.db,server.bucket,backupArg)));
}finally{await server.close();}
