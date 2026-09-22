'use strict';
const app = document.querySelector('#app');
const dialog = document.querySelector('#connect-dialog');
const state = { catalog: [], tab: 'all', search: '', connection: null, snapshot: null, project: '0', popup: null, pending: new Map(), selections: {}, selectionEpoch: 0, notice: '' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = '<svg viewBox="0 0 40 48" aria-hidden="true"><path fill="currentColor" d="M21 2C18 12 5 19 5 30a15 15 0 0 0 30 0C35 19 24 13 21 2Z"/><path d="M11 31c4 4 14 4 18-1" stroke="#2367d8" stroke-width="3" fill="none"/></svg>';
function readConnection(value) {
  const params = new URLSearchParams(value.replace(/^#/, ''));
  const bridge = params.get('bridge'), token = params.get('token');
  if (!bridge || !token) return null;
  const url = new URL(bridge);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local connection link');
  return { bridge: url.origin, token };
}
try {
  state.connection = readConnection(location.hash) || JSON.parse(sessionStorage.getItem('codegraph-connection') || 'null');
  if (state.connection) sessionStorage.setItem('codegraph-connection', JSON.stringify(state.connection));
  if (location.hash) history.replaceState({}, '', location.pathname);
} catch { sessionStorage.removeItem('codegraph-connection'); }
function toast(message) {
  const el = document.querySelector('#toast'); el.textContent = message; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 6000);
}
async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function project() { return state.snapshot?.projects.find(p => p.id === state.project); }
function installed(id) { return project()?.extensions.find(e => e.name === `managed:${id}`); }
function selected(extension) { return state.selections[extension.id]?.release || extension; }
function compatibility(extension) {
  if (!state.snapshot) return 'Connect a project to select a compatible stable release.';
  const choice = state.selections[extension.id];
  if (!choice) return 'Checking compatibility for this destination…';
  if (choice.error) return choice.error;
  return `Selected ${choice.release.version} · compatible with CodeGraph ${state.snapshot.version}, API ${state.snapshot.apiVersion} · ${project()?.name}`;
}
async function refreshSelections() {
  const epoch = ++state.selectionEpoch;
  state.selections = {};
  if (!state.snapshot || state.snapshot.busy) return;
  const destination = state.project;
  if (location.pathname !== '/publish') render();
  await Promise.all(state.catalog.map(async extension => {
    let choice;
    try { choice = { release: await rpc('command', { action: 'resolve', id: extension.id, project: destination }) }; }
    catch (error) { choice = { error: error.message }; }
    if (epoch !== state.selectionEpoch || destination !== state.project) return;
    state.selections[extension.id] = choice;
  }));
  if (epoch === state.selectionEpoch && location.pathname !== '/publish') render();
}
function button(extension, detail = false) {
  extension = selected(extension);
  const current = installed(extension.id);
  if (state.snapshot?.busy) return '<button class="primary" disabled>Updating graph…</button>';
  const ready = !state.snapshot || !!state.selections[extension.id]?.release;
  if (current) {
    return `<div class="manage-actions">${ready && current.version !== extension.version ? `<button class="primary" data-action="update" data-id="${escape(extension.id)}">Update to ${escape(extension.version)}</button>` : ''}<button data-action="${current.enabled === false ? 'enable' : 'disable'}" data-id="${escape(extension.id)}">${current.enabled === false ? 'Enable' : 'Disable'}</button>${detail ? `<button data-action="remove" data-id="${escape(extension.id)}">Remove</button>` : ''}</div>`;
  }
  return `<button class="primary" data-action="install" data-id="${escape(extension.id)}" ${ready ? '' : 'disabled'}>Install extension <span>↓</span></button>`;
}
function connectionPanel() {
  const p = project();
  return `<aside class="connection-panel"><span class="eyebrow">YOUR LOCAL CODEGRAPH</span><h3>${p ? 'Connected and in your control.' : 'One connection. Then one click.'}</h3><p>${p ? escape(p.root) : 'Choose your project once. Install an extension, and CodeGraph takes care of the rest.'}</p>${p ? `<select id="project" aria-label="Installation destination">${state.snapshot.projects.map(item => `<option value="${escape(item.id)}" ${item.id === state.project ? 'selected' : ''}>${escape(item.name)} — ${escape(item.root)}</option>`).join('')}</select>` : '<button data-connect>Connect a project <span>↗</span></button>'}<div class="footnote"><span class="dot"></span>${p ? 'Your source stays local' : 'macOS · Windows · Linux'}</div></aside>`;
}
function progress() {
  if (!state.snapshot || (!state.snapshot.busy && !state.notice && !state.snapshot.error)) return '';
  return `<div class="progress ${state.snapshot.error ? 'failed' : ''}" role="status">${escape(state.snapshot.error || state.snapshot.progress.message)}</div>`;
}
function card(extension) {
  extension = selected(extension);
  const current = installed(extension.id);
  return `<article class="extension-card"><div class="card-top"><div class="extension-icon">${extension.id === 'drupal' ? icon : escape(extension.name.slice(0, 1))}</div><div><h2><a data-link href="/extensions/${escape(extension.id)}">${escape(extension.name)}</a></h2><div class="byline">${escape(extension.publisher)} ${extension.official ? '<span class="official">✓ OFFICIAL</span>' : '<span>Community</span>'}</div></div><span class="version">v${escape(extension.version)}</span></div><p class="card-copy">${escape(extension.description)}</p><div class="tags">${extension.id === 'drupal' ? '<span class="tag">PHP</span><span class="tag">Drupal 8–11</span>' : ''}${extension.capabilities.map(c => `<span class="tag">${c === 'frameworks' ? 'Framework' : 'Semantic analysis'}</span>`).join('')}</div>${extension.id === 'drupal' ? '<div class="graph" aria-label="Example framework flow: route to controller to service"><span class="graph-node">/your-route</span><span class="graph-line"></span><span class="graph-node blue">Controller</span><span class="graph-line"></span><span class="graph-node">Service</span></div>' : ''}<p class="small muted compatibility">${escape(compatibility(extension))}</p><div class="card-bottom"><a data-link class="text-link" href="/extensions/${escape(extension.id)}">${current ? (current.enabled === false ? 'Disabled · Manage →' : 'Installed · Manage →') : 'Explore extension ↗'}</a>${button(extension)}</div></article>`;
}
function renderCatalog() {
  app.innerHTML = `<section class="hero"><div><span class="eyebrow">THE CODEGRAPH MARKETPLACE</span><h1>Make your graph<br>speak your framework.</h1><p>Add the connections that matter to your codebase.<br>Discover extensions, install in a click, and keep<br>your intelligence local.</p></div>${connectionPanel()}</section><section class="section"><div class="toolbar"><div class="tabs"><button class="tab ${state.tab === 'all' ? 'active' : ''}" data-tab="all">All extensions<span class="count">${state.catalog.length}</span></button><button class="tab ${state.tab === 'official' ? 'active' : ''}" data-tab="official">Official</button><button class="tab ${state.tab === 'installed' ? 'active' : ''}" data-tab="installed">Installed<span class="count">${project()?.extensions.length || 0}</span></button></div><label class="search">⌕<input id="search" aria-label="Search extensions" placeholder="Search frameworks, capabilities…" value="${escape(state.search)}"></label></div>${progress()}<div class="catalog-label"><span>${state.tab === 'installed' ? 'YOUR EXTENSIONS' : 'EXTEND WHAT YOUR GRAPH UNDERSTANDS'}</span><span>FRAMEWORK + SEMANTIC EXTENSIONS</span></div><div id="catalog-items"></div><div class="note-row"><span>◉ Source code stays on your machine</span><span>↻ Updates you control</span><span>◇ Open extension API</span></div></section>`;
  renderCards();
}
function renderCards() {
  const filtered = state.catalog.filter(e => (state.tab !== 'official' || e.official) && (state.tab !== 'installed' || installed(e.id)) &&
    `${e.name} ${e.description} ${e.publisher}`.toLowerCase().includes(state.search.toLowerCase()));
  document.querySelector('#catalog-items').innerHTML = `<div class="catalog">${filtered.length ? filtered.map(card).join('') : `<div class="empty">${state.tab === 'installed' && !state.snapshot ? 'Connect CodeGraph to see your installed extensions.' : state.search ? 'No extensions match your search.' : 'No extensions installed yet.'}</div>`}${state.tab !== 'installed' ? '<aside class="author-card"><span class="eyebrow">FOR BUILDERS</span><div class="author-art" aria-hidden="true">{↗}</div><h2>Your framework.<br>Your contribution.</h2><p>Turn what you know into an extension everyone can use. Start with the public API and publish your first release.</p><a data-link href="/publish">Build an extension <span>↗</span></a></aside>' : ''}</div>`;
}
function renderDetail(id) {
  const item = state.catalog.find(item => item.id === id);
  const e = item && selected(item);
  if (!e) { app.innerHTML = '<section class="section detail"><h1>Extension not found</h1><a data-link href="/">Back to marketplace</a></section>'; return; }
  const current = installed(id);
  app.innerHTML = `<section class="section detail"><div class="breadcrumb"><a data-link href="/">Marketplace</a> / ${escape(e.name)}</div><div class="detail-layout"><article><div class="card-top"><div class="extension-icon">${id === 'drupal' ? icon : escape(e.name.slice(0,1))}</div><div><h2>${escape(e.name)}</h2><div class="byline">${escape(e.publisher)} ${e.official ? '<span class="official">✓ OFFICIAL</span>' : 'Community publisher'}</div></div></div><p class="card-copy">${escape(e.description)}</p><div class="tags">${e.capabilities.map(c => `<span class="tag">${c === 'frameworks' ? 'Framework support' : 'Semantic analysis'}</span>`).join('')}</div><div class="readme">${escape(e.readme)}</div></article><aside class="metadata"><span class="eyebrow">${current ? (current.enabled === false ? 'INSTALLED · DISABLED' : 'INSTALLED') : 'READY FOR YOUR PROJECT'}</span>${button(e,true)}<p class="small muted compatibility">${escape(compatibility(e))}</p>${progress()}<p class="small muted">${project() ? `Destination: ${escape(project().name)}` : 'Connect CodeGraph once to install.'}</p><p class="small muted">Extensions run with your local permissions. Review the publisher and source before installing.</p><dl><dt>Version</dt><dd>${escape(e.version)}</dd><dt>CodeGraph compatibility</dt><dd>${escape(e.engines)}</dd><dt>Source</dt><dd><a href="${escape(e.source)}" target="_blank" rel="noopener">View source repository ↗</a></dd><dt>Published</dt><dd>${escape(new Date(e.publishedAt).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'}))}</dd><dt>Publisher identity</dt><dd class="integrity">${escape(e.publisherId)}</dd><dt>Release fingerprint</dt><dd class="integrity">${escape(e.integrity)}</dd></dl><a class="text-link" href="/api/download/${escape(e.id)}/${escape(e.version)}">Download for CLI install ↓</a></aside></div></section>`;
}
function renderPublish() {
  app.innerHTML = `<section class="section publish"><a data-link class="breadcrumb" href="/">← Marketplace</a><h1>Share what you know.</h1><p class="publish-intro">Give CodeGraph the framework knowledge your team needs. Upload a versioned extension and publish it to the community.</p><div class="publish-layout"><form id="publish-form"><div class="upload"><label for="artifact">Your extension package</label><p class="small muted">Upload the .cgext file from CodeGraph’s extension pack command.</p><input type="file" id="artifact" accept=".cgext,application/json" required><p id="package-summary" class="small"></p></div><div class="form-row"><div><label for="name">Extension name</label><input id="name" maxlength="80" placeholder="Your framework" required></div><div><label for="publisher">Publisher name</label><input id="publisher" maxlength="80" placeholder="Your name or team" required></div></div><label for="description">Short description</label><input id="description" maxlength="240" placeholder="What does this extension help people understand?" required><label for="source">Source repository</label><input id="source" type="url" placeholder="https://github.com/your-team/your-extension" required><label for="readme">Documentation</label><textarea id="readme" rows="8" maxlength="30000" placeholder="Supported patterns, configuration, examples, and known limitations." required></textarea><div class="form-actions"><button class="primary" type="submit">Publish release <span>↗</span></button><span class="small muted">Published versions are immutable.<br>Community publication does not confer official status.</span></div><p id="publish-result" role="status"></p></form><aside class="aside-notes"><span class="eyebrow">BEFORE YOU PUBLISH</span><h3>Build. Test. Share.</h3><p>Package framework or semantic contributions, and test deterministic indexing before publishing.</p><h3>Your publisher identity</h3><p>Your browser creates a signing key for your releases. Back it up to publish updates from another browser. Your key never leaves this browser during publication.</p><button id="backup-key">Back up publisher key ↓</button><label for="restore-key">Restore an existing publisher key</label><input type="file" id="restore-key" accept=".json"><p class="small">Keep your backup private. Anyone with it can publish your extensions.</p></aside></div></section>`;
}
function render() {
  if (location.pathname === '/publish') renderPublish();
  else if (location.pathname.startsWith('/extensions/')) renderDetail(decodeURIComponent(location.pathname.split('/')[2]));
  else renderCatalog();
}
async function refresh() { state.catalog = await api('/api/extensions'); render(); await refreshSelections(); }
function connect() {
  if (state.connection) { openCompanion(); return; }
  document.querySelector('#connect-command').textContent = `codegraph extensions connect --marketplace ${location.origin}`;
  dialog.showModal();
}
function openCompanion() {
  if (!state.connection) { toast('Paste the connection link from CodeGraph first.'); return; }
  state.popup = window.open(`${state.connection.bridge}/#token=${state.connection.token}`, 'codegraph-companion', 'width=650,height=620');
  if (!state.popup) { toast('Allow this site to open the CodeGraph companion window.'); return; }
  state.popup.focus();
  dialog.close();
}
function rpc(type, command) {
  if (!state.popup || state.popup.closed || !state.snapshot) return Promise.reject(new Error('Connect CodeGraph first'));
  const id = crypto.randomUUID();
  return new Promise((resolve,reject) => {
    const timer = setTimeout(()=>{state.pending.delete(id);reject(new Error('CodeGraph did not respond. Reconnect and try again.'));},15000);
    state.pending.set(id,{resolve,reject,timer});
    state.popup.postMessage({channel:'codegraph-extensions-v1',type,id,command},state.connection.bridge);
  });
}
window.addEventListener('message', event => {
  if (event.origin !== state.connection?.bridge || event.source !== state.popup || event.data?.channel !== 'codegraph-extensions-v1') return;
  const message = event.data;
  if (message.type === 'response') {
    const pending = state.pending.get(message.id); if (!pending) return;
    clearTimeout(pending.timer); state.pending.delete(message.id);
    message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.data); return;
  }
  if (message.type === 'connected' || message.type === 'status') {
    const before = JSON.stringify(state.snapshot);
    const wasBusy = state.snapshot?.busy;
    state.snapshot = message.data;
    if (wasBusy && !state.snapshot.busy && state.notice) toast(state.snapshot.progress.message);
    document.querySelector('#connect').classList.add('connected');
    document.querySelector('#connection-label').textContent = 'CodeGraph connected';
    if (message.type === 'connected') { toast('Connected. Select your project and install an extension.'); render(); void refreshSelections(); }
    else if (JSON.stringify(state.snapshot) !== before && location.pathname !== '/publish') render();
    if (wasBusy && !state.snapshot.busy) void refreshSelections();
  }
  if (message.type === 'disconnected') disconnect();
});
function disconnect() {
  state.snapshot = null; state.selections = {}; ++state.selectionEpoch; document.querySelector('#connect').classList.remove('connected');
  document.querySelector('#connection-label').textContent = 'Reconnect CodeGraph';
  if (location.pathname !== '/publish') render();
}
setInterval(()=>{if(state.snapshot && state.popup?.closed)disconnect();},2000);
async function act(action, id) {
  if (!state.snapshot) { connect(); return; }
  const extension = state.catalog.find(e => e.id === id);
  const command = {action,id,project:state.project};
  if (action === 'install' || action === 'update') {
    const release = state.selections[id]?.release;
    if (!release) { toast('Wait for compatibility selection or reconnect.'); return; }
    command.selected = { version: release.version, integrity: release.integrity };
    if (extension.official && id === 'drupal') command.replaces = ['drupal'];
  }
  try { await rpc('command',command); state.notice='operation'; toast('CodeGraph is updating your project.'); state.snapshot=await rpc('status'); render(); }
  catch(e) { toast(e.message); }
}
function navigate(url) { history.pushState({},'',url); state.search=''; render(); window.scrollTo(0,0); }
window.addEventListener('popstate',render);
document.addEventListener('click',event=>{
  const link=event.target.closest('[data-link]');if(link){event.preventDefault();navigate(link.getAttribute('href'));return;}
  const button=event.target.closest('[data-action]');if(button){void act(button.dataset.action,button.dataset.id);return;}
  const tab=event.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;renderCatalog();return;}
  if(event.target.closest('[data-connect]'))connect();
});
document.addEventListener('input',event=>{if(event.target.id==='search'){state.search=event.target.value;renderCards();}});
document.addEventListener('change',async event=>{
  if(event.target.id==='project'){state.project=event.target.value;void refreshSelections();}
  if(event.target.id==='artifact')try{
    const file=event.target.files[0];if(file.size>8*1024*1024)throw new Error('Package exceeds 8 MiB');
    const pkg=JSON.parse(await file.text()).package;
    document.querySelector('#package-summary').textContent=`${pkg.codegraph.id} · v${pkg.version} · API ${pkg.codegraph.apiVersion}`;
    document.querySelector('#name').value=pkg.codegraph.id;
    document.querySelector('#description').value=pkg.description||'';
    document.querySelector('#source').value=typeof pkg.repository==='string'?pkg.repository:'';
  }catch(e){toast(e.message);}
  if(event.target.id==='restore-key')try{const key=JSON.parse(await event.target.files[0].text());await crypto.subtle.importKey('jwk',key,{name:'ECDSA',namedCurve:'P-256'},true,['sign']);await keyStore('put',key);toast('Publisher key restored.');}catch{toast('Invalid publisher key.');}
});
document.querySelector('#connect').onclick=connect;
dialog.querySelector('.close').onclick=()=>dialog.close();
document.querySelector('#copy-command').onclick=async()=>{await navigator.clipboard.writeText(document.querySelector('#connect-command').textContent);toast('Connection command copied.');};
document.querySelector('#open-companion').onclick=()=>{
  try{const url=new URL(document.querySelector('#connection-link').value);if(url.origin!==location.origin)throw new Error('Use the connection link for this marketplace.');state.connection=readConnection(url.hash);if(!state.connection)throw new Error('Connection link is missing its local companion.');sessionStorage.setItem('codegraph-connection',JSON.stringify(state.connection));openCompanion();}
  catch(e){document.querySelector('#connect-error').textContent=e.message;}
};
function keyStore(action,key) {
  return new Promise((resolve,reject)=>{const request=indexedDB.open('codegraph-publisher',1);request.onupgradeneeded=()=>request.result.createObjectStore('keys');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction('keys',action==='put'?'readwrite':'readonly');const op=action==='put'?tx.objectStore('keys').put(key,'publisher'):tx.objectStore('keys').get('publisher');op.onsuccess=()=>{resolve(op.result);db.close();};op.onerror=()=>reject(op.error);};});
}
async function signingKey(){let jwk=await keyStore('get');if(!jwk){const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);jwk=await crypto.subtle.exportKey('jwk',pair.privateKey);await keyStore('put',jwk);}return jwk;}
const base64=bytes=>{let text='';for(const b of bytes)text+=String.fromCharCode(b);return btoa(text);};
document.addEventListener('click',async event=>{if(event.target.id!=='backup-key')return;const key=await signingKey();const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(key)],{type:'application/json'}));a.download='codegraph-publisher-private-key.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
document.addEventListener('submit',async event=>{
  if(event.target.id!=='publish-form')return;event.preventDefault();const form=event.target;const submit=form.querySelector('[type=submit]');submit.disabled=true;
  const status=document.querySelector('#publish-result');
  try{
    const file=document.querySelector('#artifact').files[0];if(!file||file.size>8*1024*1024)throw new Error('Choose a .cgext package under 8 MiB.');
    const artifact=base64(new Uint8Array(await file.arrayBuffer()));
    const jwk=await signingKey(), key=await crypto.subtle.importKey('jwk',jwk,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
    const publicKey={kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y};
    const fields=Object.fromEntries(['name','publisher','description','source','readme'].map(id=>[id,document.getElementById(id).value]));
    const payload=JSON.stringify({...fields,artifact,timestamp:Date.now(),nonce:crypto.randomUUID()});
    const signature=base64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(payload))));
    status.textContent='Validating and publishing your release…';
    const result=await api('/api/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload,publicKey,signature})});
    state.catalog=await api('/api/extensions');toast('Release published. Back up your publisher key to keep control of updates.');navigate('/extensions/'+result.id);void refreshSelections();
  }catch(e){status.textContent=e.message;}finally{submit.disabled=false;}
});
app.innerHTML='<div class="loading">Loading extensions…</div>';
refresh().catch(e=>{app.innerHTML=`<section class="section detail"><h1>Marketplace unavailable</h1><p>${escape(e.message)}</p><button id="retry">Try again</button></section>`;document.querySelector('#retry').onclick=()=>location.reload();});
