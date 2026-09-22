// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/validation/marketplace-browser.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startMarketplaceServer } = process.env.CLOUDFLARE_REGISTRY === '1' ? require('./cloudflare-registry.cjs') : require('../../dist/plugins/marketplace');
const { startExtensionBridge } = require('../../dist/plugins/bridge');
process.env.CODEGRAPH_TELEMETRY = '0';
process.env.CODEGRAPH_PARSE_WORKERS = '2';
const out = path.resolve(process.env.BROWSER_OUTPUT || '.qa/recovery/browser'); fs.mkdirSync(out, { recursive: true });
const checks = [];
const safeError = error => String(error.stack || error).replace(/token=[a-f0-9]+/g, 'token=[redacted]');
function artifact(version, broken = false) {
  return Buffer.from(JSON.stringify({ format: 'codegraph-extension-1', package: {
    name: '@browser/example', version, main: 'index.cjs', codegraph: { id: 'hosted-browser-20260922', apiVersion: 1, capabilities: ['frameworks'] },
  }, files: { 'index.cjs': `module.exports=()=>({frameworks:[{name:'route',languages:['typescript'],detect:()=>true,resolve:()=>null,
    extract(file){${broken ? "throw Error('Rejected browser update');" : ''} return {nodes:[{id:'plugin:hosted-browser-20260922:'+file,kind:'route',name:'/browser-${version}',qualifiedName:file+'::browser',filePath:file,language:'typescript',startLine:1,endLine:1,startColumn:0,endColumn:0,updatedAt:0}],references:[]}}}]});` } }));
}
function routes(root) {
  const file = path.join(root, '.codegraph/codegraph.db');
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT name FROM nodes WHERE kind='route' ORDER BY name").all().map(n => n.name); } finally { db.close(); }
}
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-browser-recovery-'));
  const roots = ['one', 'two'].map(n => path.join(temp, n));
  roots.forEach(r => { fs.mkdirSync(r); fs.writeFileSync(path.join(r, 'app.ts'), 'export function main() {}'); });
  let server, bridge, browser, attacker, debugPage, debugSnapshot, https;
  try {
    let origin = process.env.HOSTED_REGISTRY;
    assert.match(origin || '', /^https:\/\/[a-z0-9.-]+\.workers\.dev$/);
    assert.equal((await(await fetch(origin+'/api/extensions/hosted-browser-20260922')).json()).length,0,'Fixture already exists; use a fresh isolated target or rename this owned fixture');
    if (process.env.REGISTRY_TEST_HTTPS === '1') { https = await require('./https-marketplace.cjs').httpsMarketplace(server.port, out); origin = https.origin; }
    bridge = await startExtensionBridge(roots, origin);
    const token = new URLSearchParams(new URL(bridge.connectionUrl).hash.slice(1)).get('token');
    const snapshot = async () => (await fetch(bridge.url + '/status', { headers: { Authorization: 'Bearer ' + token } })).json();
    debugSnapshot = snapshot;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(30000);
    let lastPublication=0;
    async function publicationSlot(route){await new Promise(r=>setTimeout(r,Math.max(0,lastPublication+7500-Date.now())));lastPublication=Date.now();await route.continue();}
    await context.route('**/api/publish',publicationSlot);
    context.setDefaultNavigationTimeout(20000);
    const page = await context.newPage();
    debugPage = page;
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    let releaseCatalog, firstCatalog = true;
    await page.route('**/api/extensions', async route => {
      if (firstCatalog) { firstCatalog = false; await new Promise(resolve => { releaseCatalog = resolve; }); }
      await route.continue();
    });
    await page.goto(bridge.connectionUrl, { waitUntil: 'domcontentloaded' });
    if (origin.startsWith('https:')) assert.equal(await page.evaluate(() => isSecureContext), true);
    // Reproduce slow native file reads: metadata must never erase typed fields.
    await page.evaluate(() => { const original=File.prototype.text; File.prototype.text=async function(){await new Promise(resolve=>setTimeout(resolve,500));return original.call(this);}; });
    console.log('Opened marketplace');
    await page.getByRole('link', { name: 'Publish an extension' }).click();
    async function publish(version, broken = false) {
      console.log('Publishing', version);
      if (new URL(page.url()).pathname !== '/publish') await page.getByRole('link', { name: 'Publish an extension' }).click();
      await page.locator('#artifact').setInputFiles({ name: 'example.cgext', mimeType: 'application/json', buffer: artifact(version, broken) });
      await page.locator('#name').fill('Browser example');
      await page.locator('#publisher').fill('Recovery publisher');
      await page.locator('#description').fill('A second framework used for end-to-end validation.');
      await page.locator('#source').fill('https://example.com/recovery-source');
      await page.locator('#readme').fill('Validation-only extension. Adds one explicit route to each TypeScript file.');
      await page.locator('#package-summary').filter({ hasText: 'v'+version+' ·' }).waitFor();
      if (releaseCatalog) {
        const response = page.waitForResponse(r=>r.url().endsWith('/api/extensions'));
        releaseCatalog(); releaseCatalog = undefined; await response;
        await page.waitForTimeout(200);
        assert.equal(await page.locator('#artifact').evaluate(input=>input.files[0]?.name),'example.cgext');
        checks.push('late catalog response preserves the entered publisher form and package');
      }
      assert.equal(await page.locator('#description').inputValue(), 'A second framework used for end-to-end validation.');
      assert.equal(await page.locator('#source').inputValue(), 'https://example.com/recovery-source');
      await page.getByRole('button', { name: 'Publish release' }).click();
      console.log('Submitted', version);
      await page.waitForURL('**/extensions/hosted-browser-20260922');
      await page.getByText(version, { exact: true }).waitFor();
    }
    await publish('1.0.0'); checks.push('real browser signed publisher upload'); checks.push('slow package metadata preserves typed publisher fields');
    const first = (await (await fetch(origin + '/api/extensions')).json()).find(x=>x.id==='hosted-browser-20260922');
    assert.equal(first.official, false);
    // A separate browser has a separate signing identity and cannot claim this id.
    const otherContext = await browser.newContext();
    otherContext.setDefaultTimeout(30000);
    await otherContext.route('**/api/publish',publicationSlot);
    const other = await otherContext.newPage();
    await other.goto(origin + '/publish');
    await other.locator('#artifact').setInputFiles({ name: 'example.cgext', mimeType: 'application/json', buffer: artifact('9.0.0') });
    for (const [id, value] of Object.entries({ name: 'Attempted takeover', publisher: 'Other publisher', description: 'Test', source: 'https://example.com/other', readme: 'Test' })) await other.locator('#' + id).fill(value);
    await other.getByRole('button', { name: 'Publish release' }).click();
    await other.getByText('This extension id belongs to another publisher', { exact: true }).waitFor();
    checks.push('browser publisher ownership rejection');
    // Send the real form submission to the real API with a corrupted signature.
    await other.route('**/api/publish', async route => {
      const body = route.request().postDataJSON(); body.signature = 'invalid';
      await route.continue({ postData: JSON.stringify(body) });
    });
    await other.getByRole('button', { name: 'Publish release' }).click();
    await other.locator('#publish-result').filter({ hasText: /signature/i }).waitFor();
    await other.unroute('**/api/publish');
    checks.push('browser invalid-signature failure state');
    const malformed = JSON.parse(artifact('9.0.0')); malformed.format = 'invalid-format';
    await other.locator('#artifact').setInputFiles({ name: 'invalid.cgext', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(malformed)) });
    await other.locator('#description').fill('Invalid package validation');
    await other.locator('#source').fill('https://example.com/invalid');
    await other.getByRole('button', { name: 'Publish release' }).click();
    await other.locator('#publish-result').filter({ hasText: /package/i }).waitFor();
    assert.equal((await (await fetch(origin + '/api/extensions/hosted-browser-20260922')).json()).length, 1);
    await otherContext.close(); checks.push('browser malformed-package rejection without publication');
    await page.getByRole('link', { name: 'Marketplace', exact: true }).first().click();
    await page.getByRole('link', {name:'Browser example',exact:true}).click();
    const popupPromise = page.waitForEvent('popup');
    await page.locator('#connect').click();
    const popup = await popupPromise;
    await popup.getByRole('button', { name: 'Allow connection' }).click();
    await page.getByText('CodeGraph connected', { exact: true }).waitFor();
    await page.locator('#project').selectOption('1');
    let completedJob = 0;
    await page.getByRole('button', { name: 'Install extension' }).click();
    async function settle(expected) {
      await page.waitForFunction(previous => state.snapshot && !state.snapshot.busy && state.snapshot.jobId > previous, completedJob);
      const current = await snapshot();
      completedJob = current.jobId;
      console.log('Companion result', JSON.stringify({ progress: current.progress, error: current.error, jobId: current.jobId }));
      assert.ok(!current.error, current.error);
      await page.getByText(expected, { exact: true }).first().waitFor({ timeout: 60000 });
    }
    await settle('Extension activated and graph refreshed');
    assert.deepEqual(routes(roots[1]), ['/browser-1.0.0']); assert.deepEqual(routes(roots[0]), []);
    checks.push('one-click selected-project install verified in SQLite');
    await page.screenshot({ path: path.join(out, 'desktop-installed.png'), fullPage: true });
    // Real same-origin message from an iframe: right origin, wrong source window.
    const before = (await snapshot()).jobId;
    await page.evaluate(() => {
      window.__recoveryPopup = state.popup;
      const iframe = document.createElement('iframe'); iframe.name = 'wrong-source'; document.body.append(iframe);
    });
    await page.frame({ name: 'wrong-source' }).evaluate(() => parent.__recoveryPopup.postMessage({ channel: 'codegraph-extensions-v1', type: 'command', id: 'wrong-window', command: { action: 'remove', id: 'hosted-browser-20260922', project: '1' } }, '*'));
    await page.waitForTimeout(300); assert.equal((await snapshot()).jobId, before);
    await page.locator('iframe[name="wrong-source"]').evaluate(node => node.remove());
    checks.push('real postMessage wrong-window command ignored');
    await publish('2.0.0', true);
    await page.getByRole('button', { name: 'Update to 2.0.0' }).click();
    await page.getByText(/Extension activation failed/).first().waitFor({ timeout: 60000 });
    completedJob = (await snapshot()).jobId;
    assert.deepEqual(routes(roots[1]), ['/browser-1.0.0']);
    assert.equal((await snapshot()).projects[1].extensions[0].version, '1.0.0');
    checks.push('failed browser update preserves working version and graph');
    await publish('3.0.0');
    await page.getByRole('button', { name: 'Update to 3.0.0' }).click();
    await settle('Extension activated and graph refreshed');
    assert.deepEqual(routes(roots[1]), ['/browser-3.0.0']);
    checks.push('browser update replaces stale graph contributions');
    await page.getByRole('button', { name: 'Disable', exact: true }).click();
    await page.getByRole('button', { name: 'Enable', exact: true }).waitFor({ timeout: 60000 });
    assert.deepEqual(routes(roots[1]), []);
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await page.getByRole('button', { name: 'Disable', exact: true }).waitFor({ timeout: 60000 });
    assert.deepEqual(routes(roots[1]), ['/browser-3.0.0']);
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: 'Install extension' }).waitFor({ timeout: 60000 });
    await page.getByText('Extension removed and graph refreshed', { exact: true }).first().waitFor();
    assert.deepEqual(routes(roots[1]), []); assert.deepEqual(routes(roots[0]), []);
    checks.push('browser disable/enable/remove verified in SQLite');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('CodeGraph compatibility', { exact: true }).waitFor();
    await page.getByText('3.0.0', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(out, 'mobile-detail.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    checks.push('mobile detail fits viewport');
    // Bootstrap a companion from a hostile origin, even with a valid test token:
    // its real message origin must still be refused after the local allow click.
    attacker = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<button id="open">Open</button>'); });
    await new Promise(resolve => attacker.listen(0, '127.0.0.1', resolve));
    const evil = await context.newPage(); await evil.goto(`http://127.0.0.1:${attacker.address().port}`);
    await evil.evaluate(({ url }) => { document.querySelector('#open').onclick = () => { window.target = window.open(url, '_blank'); }; }, { url: bridge.url + '/#token=' + token });
    const badPopupPromise = evil.waitForEvent('popup'); await evil.locator('#open').click(); const badPopup = await badPopupPromise;
    await badPopup.getByRole('button', { name: 'Allow connection' }).click();
    const beforeOrigin = (await snapshot()).jobId;
    await evil.evaluate(() => window.target.postMessage({ channel: 'codegraph-extensions-v1', type: 'command', id: 'wrong-origin', command: { action: 'enable', id: 'hosted-browser-20260922', project: '1' } }, '*'));
    await evil.waitForTimeout(300); assert.equal((await snapshot()).jobId, beforeOrigin);
    checks.push('real postMessage wrong-origin command ignored');
    await popup.close();
    await page.getByText('Reconnect CodeGraph', { exact: true }).waitFor();
    checks.push('closed local companion expires the connection visibly');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('link', { name: 'Publish an extension' }).click();
    await page.locator('#artifact').setInputFiles({ name: 'example.cgext', mimeType: 'application/json', buffer: artifact('4.0.0') });
    for (const [id, value] of Object.entries({ name: 'Browser example', publisher: 'Recovery publisher', description: 'Outage check', source: 'https://example.com/source', readme: 'Outage check' })) await page.locator('#'+id).fill(value);
    await page.locator('#package-summary').filter({ hasText: 'v4.0.0' }).waitFor();
    await page.route('**/api/publish', route=>route.abort('connectionfailed'));
    await page.getByRole('button', { name: 'Publish release' }).click();
    await page.locator('#publish-result').filter({ hasText: /marketplace registry/i }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Publish release' }).isEnabled(), true);
    assert.deepEqual(routes(roots[1]), []);
    checks.push('injected client transport outage shows actionable publisher failure (provider remains running) without changing local graph');
    assert.deepEqual(pageErrors, []);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ origin, browser: browser.version(), platform: process.platform, checks, pageErrors }, null, 2));
    console.log(JSON.stringify({ checks, browser: browser.version(), platform: process.platform }));
  } catch (error) {
    await debugPage?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ checks, error: safeError(error), snapshot: await debugSnapshot?.() }, null, 2)); throw Error(safeError(error));
  } finally {
    await browser?.close(); await https?.close(); await bridge?.close(); await server?.close();
    if (attacker) await new Promise(resolve => attacker.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(safeError(error)); if(error.cause) console.error(error.cause); process.exitCode = 1; });
