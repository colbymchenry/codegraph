// Build first; PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/validation/extensions-compatibility.cjs
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { generateKeyPairSync, sign, randomUUID, createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createExtensionProject, CodeGraph } = require('../../dist');
const { packExtension } = require('../../dist/plugins/package');
const { startMarketplaceServer } = process.env.CLOUDFLARE_REGISTRY === '1' ? require('./cloudflare-registry.cjs') : require('../../dist/plugins/marketplace');
const { startExtensionBridge } = require('../../dist/plugins/bridge');
const repo = path.resolve(__dirname, '../..'), out = path.resolve(process.env.COMPAT_OUTPUT || path.join(repo, '.qa/recovery/compatibility'));
fs.mkdirSync(out, { recursive: true });
const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-compatible-'));
const author = path.join(lab, 'author'), checks = [], commands = [], releases = [];
const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_PARSE_WORKERS: '2', CODEGRAPH_RESOLVE_WORKERS: '2', CODEGRAPH_PARALLEL_RESOLVE_MIN: '0' };
Object.assign(process.env, env);
const roots = ['first-python-project', 'selected-python-project', 'headless-python-project'].map(n => path.join(lab, n));
for (const root of roots) {
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'checkout.events.yaml'), 'order.created: send_receipt\n');
  fs.writeFileSync(path.join(root, 'handlers.py'), 'def send_receipt():\n    return "sent"\n');
}
createExtensionProject(author, 'compatible-demo');
const original = fs.readFileSync(path.join(author, 'index.cjs'), 'utf8');
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
let server, bridge, browser, page, registry, https;
async function publish(version, engines = '>=1.6.0 <2', id = 'compatible-demo', broken = false) {
  const pkg = JSON.parse(fs.readFileSync(path.join(author, 'package.json'), 'utf8'));
  pkg.version = version; pkg.codegraph.id = id; pkg.codegraph.engines = engines;
  fs.writeFileSync(path.join(author, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(author, 'index.cjs'), original.replace('Python event dispatch', 'Python event dispatch ' + version).replace('extract(file, source) {', broken ? "extract(file, source) { throw Error('Rejected compatible update');" : 'extract(file, source) {'));
  const bytes = packExtension(author);
  const payload = JSON.stringify({ name: id, description: 'Compatible generated Python event extension', publisher: 'Compatibility validation',
    source: 'https://github.com/fixture/source', sourceRevision:'a'.repeat(40), sourcePath:'fixture.cgext', readme: 'Generated author template; local release selection acceptance.', artifact: bytes.toString('base64'), timestamp: Date.now(), nonce: randomUUID() });
  const body = { payload, publicKey: keys.publicKey.export({ format: 'jwk' }), signature: sign('sha256', Buffer.from(payload), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') };
  const res = await fetch(registry + '/api/publish', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(res.status, 201, await res.clone().text());
  releases.push({ id, version, engines, integrity: createHash('sha256').update(bytes).digest('hex') });
  return { bytes, body };
}
async function graph(root) {
  if (!CodeGraph.isInitialized(root)) return [];
  const g = await CodeGraph.open(root);
  try { return g.getNodesByKind('route').flatMap(n => g.getOutgoingEdges(n.id).filter(e => e.metadata?.synthesizedBy === 'compatible-demo').map(e => ({ source: n.name, target: g.getNode(e.target)?.name, label: e.metadata.label }))); }
  finally { g.close(); }
}
async function expectGraph(root, version) {
  assert.deepEqual(await graph(root), [{ source: 'event:order.created', target: 'send_receipt', label: 'Python event dispatch ' + version }]);
}
async function cli(args, expected = 0) {
  const command = [path.join(repo, 'dist/bin/codegraph.js'), 'extensions', ...args];
  const start = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command, { env, cwd: lab, timeout: 120000 });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.on('error', reject); child.on('close', exit => resolve({ exit, stdout, stderr }));
  });
  commands.push({ command: [process.execPath, ...command], exit: result.exit, seconds: (Date.now() - start) / 1000 });
  fs.writeFileSync(path.join(out, 'commands.json'), JSON.stringify(commands, null, 2));
  fs.writeFileSync(path.join(out, `command-${commands.length}.log`), result.stdout + result.stderr);
  assert.equal(result.exit, expected, result.stderr); return result;
}
(async () => {
  try {
    server = await startMarketplaceServer({ database: path.join(lab, 'registry.db'), publicDirectory: path.join(repo, 'marketplace/public') });
    registry = `http://127.0.0.1:${server.port}`;
    if (process.env.REGISTRY_TEST_HTTPS === '1') { https = await require('./https-marketplace.cjs').httpsMarketplace(server.port, out); registry = https.origin; }
    // Publication order intentionally differs from semantic order; previews and
    // a newer incompatible release must never displace the compatible stable one.
    const pinned = await publish('1.10.0'); await publish('1.9.0'); await publish('0.5.0');
    await publish('20.0.0-beta.1'); await publish('9.0.0', '>=9'); await publish('1.0.0', '>=9', 'unavailable-demo');
    const duplicate = await fetch(registry + '/api/publish', { method: 'POST', body: JSON.stringify(pinned.body) });
    assert.equal(duplicate.status, 400);
    const all = await (await fetch(registry + '/api/extensions/compatible-demo')).json();
    assert.deepEqual(all.map(r => r.version), ['9.0.0', '1.10.0', '1.9.0', '0.5.0', '20.0.0-beta.1']);
    assert.equal(all[0].apiVersion, 1); checks.push('signed immutable versions; semantic catalog order independent of publication order');
    bridge = await startExtensionBridge(roots.slice(0, 2), registry);
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(60000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(bridge.connectionUrl);
    if (https) assert.equal(await page.evaluate(() => isSecureContext), true);
    const popupWait = page.waitForEvent('popup'); await page.locator('#connect').click(); const popup = await popupWait;
    await popup.getByRole('button', { name: 'Allow connection' }).click();
    await page.getByText('CodeGraph connected', { exact: true }).waitFor();
    await page.locator('#project').selectOption('1');
    await page.locator('.compatibility').filter({ hasText: 'Selected 1.10.0' }).waitFor();
    await page.getByRole('link', { name: 'compatible-demo', exact: true }).click();
    await page.locator('.compatibility').filter({ hasText: 'selected-python-project' }).waitFor();
    await page.screenshot({ path: path.join(out, 'desktop-selected.png'), fullPage: true });
    // Exactly one Install after connection; wait for the real companion job.
    await page.getByRole('button', { name: 'Install extension' }).click();
    await page.waitForFunction(() => state.snapshot?.jobId === 1 && !state.snapshot.busy);
    assert.equal(await page.evaluate(() => state.snapshot.error), undefined);
    await expectGraph(roots[1], '1.10.0'); assert.deepEqual(await graph(roots[0]), []);
    checks.push('one browser Install selects 1.10.0 over incompatible 9.0.0 and preview; actual Python graph refreshed only in chosen destination');
    // Hold actual bridge resolution to inspect the transient destination state.
    await page.evaluate(() => {
      const originalRpc = rpc;
      const gate = new Promise(resolve => window.releaseSelection = resolve);
      rpc = (type, value) => type === 'command' && value?.action === 'resolve' ? gate.then(() => originalRpc(type, value)) : originalRpc(type, value);
      window.pendingSelection = refreshSelections().finally(() => { rpc = originalRpc; });
    });
    await page.screenshot({ path: path.join(out, 'metadata-pending.png'), fullPage: true });
    assert.equal(await page.locator('[data-installed-version]').innerText(), '1.10.0');
    assert.equal(await page.locator('[data-selected-version]').innerText(), 'Checking compatibility…');
    assert.equal(await page.locator('a[href^="/api/download/"]').count(), 0);
    await page.evaluate(async () => { releaseSelection(); await pendingSelection; });
    assert.equal(await page.locator('[data-selected-version]').innerText(), '1.10.0');
    assert.equal(await page.locator('[data-installed-version]').innerText(), '1.10.0');
    checks.push('pending compatibility refresh never shows incompatible catalog version as selected; installed and selected versions remain distinct');
    await page.screenshot({ path: path.join(out, 'desktop-installed.png'), fullPage: true });
    const config = fs.readFileSync(path.join(roots[1], 'codegraph.json'), 'utf8');
    const noChoice = await page.evaluate(async () => {
      try { await rpc('command', { action: 'resolve', id: 'unavailable-demo', project: '1' }); return ''; } catch (e) { return e.message; }
    });
    assert.match(noChoice, /No compatible stable release/);
    await page.evaluate(() => rpc('command', { action: 'install', id: 'unavailable-demo', project: '1' }));
    await page.waitForFunction(() => state.snapshot?.jobId === 2 && !state.snapshot.busy);
    assert.match(await page.evaluate(() => state.snapshot.error), /No compatible stable release/);
    assert.equal(fs.readFileSync(path.join(roots[1], 'codegraph.json'), 'utf8'), config); await expectGraph(roots[1], '1.10.0');
    await page.evaluate(() => navigate('/extensions/unavailable-demo'));
    await page.locator('.compatibility').filter({ hasText: 'No compatible stable release' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Install extension' }).isDisabled(), true);
    checks.push('no-compatible browser selection/command fails usefully and preserves existing config/graph');
    // Independent CLI destination resolves exactly the same release.
    await cli(['install', 'compatible-demo', '--registry', registry, '--path', roots[2]]); await expectGraph(roots[2], '1.10.0');
    const headlessConfig = fs.readFileSync(path.join(roots[2], 'codegraph.json'), 'utf8');
    const exactFailure = await cli(['install', 'compatible-demo', '--registry', registry, '--version', '9.0.0', '--path', roots[2]], 1);
    assert.match(exactFailure.stderr, /No compatible exact release 9.0.0/);
    await cli(['update', 'unavailable-demo', '--registry', registry, '--path', roots[2]], 1);
    const none = await cli(['install', 'unavailable-demo', '--registry', registry, '--path', roots[2]], 1);
    assert.match(none.stderr, /No compatible stable release/);
    assert.equal(fs.readFileSync(path.join(roots[2], 'codegraph.json'), 'utf8'), headlessConfig); await expectGraph(roots[2], '1.10.0');
    checks.push('headless automatic selection agrees; exact incompatible pin/no-compatible/missing update fail without mutation');
    await cli(['install', 'compatible-demo', '--registry', registry, '--version', '20.0.0-beta.1', '--path', roots[2]]);
    await expectGraph(roots[2], '20.0.0-beta.1');
    const previewConfig = fs.readFileSync(path.join(roots[2], 'codegraph.json'), 'utf8');
    const downgrade = await cli(['update', 'compatible-demo', '--registry', registry, '--path', roots[2]], 1);
    assert.match(downgrade.stderr, /would downgrade/);
    assert.equal(fs.readFileSync(path.join(roots[2], 'codegraph.json'), 'utf8'), previewConfig); await expectGraph(roots[2], '20.0.0-beta.1');
    await cli(['install', 'compatible-demo', '--registry', registry, '--version', '1.9.0', '--path', roots[2]]); await expectGraph(roots[2], '1.9.0');
    checks.push('prerelease requires explicit exact pin; automatic update refuses downgrade; explicit lower pin remains exact');
    await publish('2.0.0', '>=1.6.0 <2', 'compatible-demo', true);
    await page.reload(); const reconnect = page.waitForEvent('popup');
    // A named existing popup may be reused: reconnect using a fresh window.
    await popup.close(); await page.locator('#connect').click(); const second = await reconnect;
    await second.getByRole('button', { name: 'Allow connection' }).click();
    await page.getByText('CodeGraph connected', { exact: true }).waitFor();
    await page.evaluate(() => { state.project = '1'; navigate('/extensions/compatible-demo'); return refreshSelections(); });
    await page.getByRole('button', { name: 'Update to 2.0.0' }).click();
    await page.waitForFunction(() => state.snapshot?.jobId === 3 && !state.snapshot.busy);
    assert.match(await page.evaluate(() => state.snapshot.error), /Extension activation failed/);
    await expectGraph(roots[1], '1.10.0'); assert.equal(fs.readFileSync(path.join(roots[1], 'codegraph.json'), 'utf8'), config);
    checks.push('compatible but broken update retains previous version and graph');
    await publish('3.0.0');
    await page.evaluate(() => refresh());
    await page.getByRole('button', { name: 'Update to 3.0.0' }).click();
    await page.waitForFunction(() => state.snapshot?.jobId === 4 && !state.snapshot.busy);
    assert.equal(await page.evaluate(() => state.snapshot.error), undefined); await expectGraph(roots[1], '3.0.0');
    await cli(['update', 'compatible-demo', '--registry', registry, '--path', roots[2]]); await expectGraph(roots[2], '3.0.0');
    checks.push('browser and headless update to highest compatible stable; stale graph labels removed');
    // Exact URL and file install remain independent of automatic registry selection.
    await cli(['install', registry + '/api/download/compatible-demo/1.9.0', '--path', roots[2]]); await expectGraph(roots[2], '1.9.0');
    const file = path.join(lab, 'pinned.cgext'); fs.writeFileSync(file, pinned.bytes);
    await cli(['install', file, '--path', roots[2]]); await expectGraph(roots[2], '1.10.0');
    await publish('1.10.0+fixture.1');
    await cli(['install', 'compatible-demo', '--registry', registry, '--version', '1.10.0+fixture.1', '--path', roots[2]]);
    await expectGraph(roots[2], '1.10.0+fixture.1');
    checks.push('exact artifact URL/file semantics and build-metadata pin identity preserved');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.compatibility').filter({ hasText: 'Selected 3.0.0' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(out, 'mobile-selected.png'), fullPage: true });
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.waitForFunction(() => state.snapshot?.jobId === 5 && !state.snapshot.busy);
    await cli(['remove', 'compatible-demo', '--path', roots[2]]);
    assert.deepEqual(await graph(roots[1]), []); assert.deepEqual(await graph(roots[2]), []);
    assert.deepEqual(errors, []); checks.push('removal cleans contributions; desktop/mobile display actual destination compatibility; no page errors');
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ checks, releases, commands, engineVersion: require('../../package.json').version, platform: process.platform, browser: browser.version() }, null, 2));
    console.log(JSON.stringify({ checks, commands: commands.length }));
  } catch (error) {
    await page?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ checks, error: String(error.stack).replace(/token=[a-f0-9]+/g, 'token=[redacted]') }, null, 2)); throw error;
  } finally { await browser?.close(); await https?.close(); await bridge?.close(); await server?.close(); fs.rmSync(lab, { recursive: true, force: true }); }
})().catch(error => { console.error(String(error.stack).replace(/token=[a-f0-9]+/g, 'token=[redacted]')); if(error.cause) console.error(error.cause); process.exitCode = 1; });
