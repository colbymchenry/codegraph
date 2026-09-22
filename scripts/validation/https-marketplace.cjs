// Optional real HTTPS transport for disposable browser acceptance. This is a
// temporary public tunnel, never durable-hosting evidence or a deployment.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
exports.httpsMarketplace = async function(port, out) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tunnel-'));
  const logPath = path.join(out,'https-tunnel.log'), log = fs.openSync(logPath,'w');
  const child = spawn('cloudflared', ['tunnel','--no-autoupdate','--protocol','http2','--metrics','127.0.0.1:0','--url',`http://127.0.0.1:${port}`], {
    env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore',log,log],
  });
  let failure, closed = false;
  child.on('error', e=>failure=e); child.on('close',()=>closed=true);
  const close = async () => { if (!closed) { child.kill('SIGTERM'); await new Promise(resolve=>child.once('close',resolve)); } fs.closeSync(log); fs.rmSync(home,{recursive:true,force:true}); };
  try {
    const deadline = Date.now()+90000;
    while (Date.now()<deadline) {
      if(failure) throw failure; if(closed) throw Error('Test HTTPS tunnel exited; see https-tunnel.log');
      const contents = fs.readFileSync(logPath,'utf8'), url = contents.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      if(url && contents.includes('Registered tunnel connection')) {
        try { const response = await fetch(url+'/api/health',{signal:AbortSignal.timeout(5000)}); if(response.ok && (await response.json()).ok) {
          fs.writeFileSync(path.join(out,'https-transport.json'),JSON.stringify({origin:url,kind:'temporary-public-tunnel',durableHosting:false,verifiedAt:new Date().toISOString()},null,2));
          return { origin:url, close };
        }} catch (error) { fs.appendFileSync(path.join(out,'https-network-errors.log'),new Date().toISOString()+' '+String(error)+' '+String(error.cause?.stack || '')+'\n'); }
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw Error('Test HTTPS tunnel did not become reachable; see https-tunnel.log');
  } catch(error) { await close(); throw error; }
};
