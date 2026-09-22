import {startLocal} from './local.mjs';
const server=await startLocal({state:process.argv[2],testing:true,boundary:async req=>{process.send({phase:new URL(req.url).pathname.slice(1)});return new Promise(()=>{});}});
process.send({ready:true,port:server.port});
