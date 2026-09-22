import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ExtensionManager, downloadPackage, type ExtensionProgress } from './manager';
import { validateExtensionId } from './releases';
import { version } from '../../package.json';

export interface BridgeHandle { url: string; connectionUrl: string; close(): Promise<void> }

/**
 * A loopback companion window is a transport, not a public HTTP installation
 * endpoint. Only its launcher knows the bearer secret; the hosted marketplace
 * communicates through an exact-origin + exact-window postMessage channel.
 */
export async function startExtensionBridge(roots: string[], marketplace: string, port = 0): Promise<BridgeHandle> {
  const market = new URL(marketplace);
  if (market.protocol !== 'https:' && !(market.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(market.hostname))) throw new Error('Marketplace must use HTTPS');
  const token = randomBytes(32).toString('hex');
  const projects = [...new Set(roots.map(r => fs.realpathSync(r)))].map((root, i) => ({ id: String(i), name: path.basename(root), root }));
  if (!projects.length) throw new Error('Select at least one project');
  let progress: ExtensionProgress = { state: 'ready', message: 'Connected. Choose an extension in the marketplace.' };
  let job: Promise<void> | undefined;
  let jobId = 0;
  let failure: string | undefined;
  const managers = projects.map(p => new ExtensionManager(p.root, event => { progress = event; }));
  let origin = '';
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const reply = (status: number, data: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) { reply(403, { error: 'Invalid local host' }); return; }
    if (req.headers.origin && req.headers.origin !== origin) { reply(403, { error: 'Cross-origin HTTP access refused' }); return; }
    const route = req.url?.split('?')[0];
    if (req.method === 'GET' && route === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(companionHtml); return;
    }
    if (req.method === 'GET' && route === '/companion.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(companionScript(market.origin)); return;
    }
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) { reply(401, { error: 'Connect CodeGraph first' }); return; }
    if (req.method === 'GET' && route === '/status') {
      reply(200, { version, apiVersion: 1, projects: projects.map((p, i) => ({ ...p, extensions: managers[i]!.list() })), progress, jobId, busy: !!job, error: failure }); return;
    }
    if (req.method !== 'POST' || route !== '/command') { reply(404, { error: 'Unknown command' }); return; }
    if (job) { reply(409, { error: 'An operation is already running' }); return; }
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error('Command too large'); }
      const command = JSON.parse(body);
      const index = projects.findIndex(p => p.id === command.project);
      if (index < 0) throw new Error('Unknown destination');
      if (!['resolve', 'install', 'update', 'disable', 'enable', 'remove'].includes(command.action)) throw new Error('Unknown operation');
      if (command.action === 'resolve') {
        validateExtensionId(command.id);
        reply(200, await managers[index]!.resolve({ registry: market.origin, id: command.id, version: command.version, update: command.update === true })); return;
      }
      if (['install', 'update'].includes(command.action)) {
        if (command.url !== undefined) {
          if (typeof command.url !== 'string' || new URL(command.url).origin !== market.origin || !/^[a-f0-9]{64}$/.test(command.integrity)) throw new Error('Expected a pinned release from this marketplace');
        } else {
          validateExtensionId(command.id);
          if (command.selected !== undefined && (typeof command.selected?.version !== 'string' || !/^[a-f0-9]{64}$/.test(command.selected?.integrity))) throw new Error('Invalid selected release');
        }
        if (command.replaces !== undefined && (!Array.isArray(command.replaces) || command.replaces.some((v: unknown) => typeof v !== 'string'))) throw new Error('Invalid replacement list');
      } else if (typeof command.id !== 'string') throw new Error('Extension id required');
      const manager = managers[index]!;
      failure = undefined; jobId++;
      progress = { state: 'downloading', message: 'Preparing extension operation' };
      job = (async () => {
        if (command.action === 'install' || command.action === 'update') {
          if (command.url !== undefined) {
            const bytes = await downloadPackage(command.url, market.origin);
            await manager.install({ bytes, integrity: command.integrity, source: command.url, replaces: command.replaces });
          } else await manager.installFromRegistry({ registry: market.origin, id: command.id, version: command.version,
            update: command.action === 'update', selected: command.selected, replaces: command.replaces });
        } else if (command.action === 'remove') await manager.remove(command.id);
        else await manager.setEnabled(command.id, command.action === 'enable');
      })().catch(err => { failure = String(err); progress = { state: 'failed', message: failure }; }).finally(() => { job = undefined; });
      reply(202, { jobId });
    } catch (err) { reply(400, { error: String(err) }); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
  const connection = new URL(marketplace);
  // Fragments never enter hosted server logs or referrers. The marketplace
  // removes this fragment and keeps the connection in session storage only.
  connection.hash = new URLSearchParams({ bridge: origin, token }).toString();
  return { url: origin, connectionUrl: connection.href, close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())) };
}

const companionHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CodeGraph connection</title><style>body{font:16px system-ui;background:#f7f6f2;color:#16150f;max-width:560px;margin:70px auto;padding:24px}h1{font-size:40px;letter-spacing:-2px}button{font:inherit;background:#16150f;color:#f7f6f2;border:0;padding:14px 22px;cursor:pointer}p{line-height:1.6}small{color:#56544a}#status{border-top:1px solid #d6d3c8;margin-top:32px;padding-top:24px}</style><h1>Connect your CodeGraph.</h1><p id="destination"></p><p>Allow this marketplace to install and manage extensions in the projects you selected. Extensions run code on this computer with your permissions.</p><button id="connect">Allow connection</button><p id="status" role="status">Keep this window open while using the marketplace.</p><small>Your source code stays on this computer.</small><script src="/companion.js"></script></html>`;

function companionScript(market: string): string {
  return `const marketplace=${JSON.stringify(market)};
const token=new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null,'',location.pathname);
let connected=false;
const status=document.getElementById('status');
document.getElementById('destination').textContent='Marketplace: '+marketplace;
const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
async function snapshot(){const r=await fetch('/status',{headers});if(!r.ok)throw new Error('Connection expired. Run codegraph extensions connect again.');return r.json();}
const send=data=>{if(window.opener)window.opener.postMessage({channel:'codegraph-extensions-v1',...data},marketplace);};
document.getElementById('connect').onclick=async()=>{try{const data=await snapshot();connected=true;document.getElementById('connect').hidden=true;status.textContent='Connected. Return to the marketplace.';send({type:'connected',data});}catch(e){status.textContent=e.message;}};
window.addEventListener('message',async event=>{
 if(!connected||event.origin!==marketplace||event.source!==window.opener||event.data?.channel!=='codegraph-extensions-v1')return;
 const request=event.data;
 try{
   if(request.type==='status'){send({type:'response',id:request.id,data:await snapshot()});return;}
   if(request.type!=='command')return;
   const response=await fetch('/command',{method:'POST',headers,body:JSON.stringify(request.command)});
   const data=await response.json();if(!response.ok)throw new Error(data.error);
   send({type:'response',id:request.id,data});
 }catch(e){send({type:'response',id:request.id,error:e.message});}
});
setInterval(async()=>{if(!connected)return;try{const data=await snapshot();status.textContent=data.progress.message;send({type:'status',data});}catch(e){status.textContent=e.message;send({type:'disconnected'});connected=false;}},1000);`;
}
