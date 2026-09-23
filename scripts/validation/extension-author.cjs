// Build core first. Creates a new author project OUTSIDE core using only the CLI.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/validation/extension-author.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { startMarketplaceServer } = require('../../dist/plugins/marketplace');
const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.AUTHOR_OUTPUT || path.join(repo, '.qa/recovery/author-e2e'));
fs.mkdirSync(out, { recursive: true });
const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-external-author-'));
const author = path.join(lab, 'python-events');
const project = path.join(lab, 'python-app');
const commands = [];
const env = { ...process.env, npm_config_cache: path.join(lab, 'npm-cache'), CODEGRAPH_TELEMETRY: '0', CODEGRAPH_PARSE_WORKERS: '2', CODEGRAPH_RESOLVE_WORKERS: '2', CODEGRAPH_PARALLEL_RESOLVE_MIN: '0' };
async function run(command, args, cwd = lab) {
  if (command === 'npm') [command, args] = require('./platform-tools.cjs').npmCommand(args);
  const start = Date.now();
  // Keep the event loop responsive while the CLI downloads from our local registry.
  const result = await new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, timeout: 180000 });
    let stdout = '', stderr = '', error;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', value => { error = value; });
    child.on('close', status => resolve({ status, stdout, stderr, error }));
  });
  commands.push({ command: [command, ...args], cwd, exit: result.status, seconds: (Date.now() - start) / 1000 });
  const prefix = path.join(out, `command-${commands.length}`);
  fs.writeFileSync(prefix + '.log', (result.stdout || '') + (result.stderr || ''));
  fs.writeFileSync(path.join(out, 'commands.json'), JSON.stringify(commands, null, 2));
  assert.equal(result.status, 0, `${command} failed: ${result.error || result.stderr || result.stdout}`);
  return result.stdout;
}
let server, browser;
(async () => {
  await run(process.execPath, [path.join(repo, 'dist/bin/codegraph.js'), 'extensions', 'create', author, '--id', 'python-events']);
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', lab], repo))[0];
  assert.ok(packed.files.some(f => f.path === 'docs/extensions/authoring.md'), 'guide ships in the development package');
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', path.join(lab, packed.filename)], author);
  const requireAuthor = createRequire(path.join(author, 'package.json'));
  const sdk = requireAuthor('@colbymchenry/codegraph');
  assert.equal(sdk.EXTENSION_API_VERSION, 1);
  assert.equal(typeof sdk.testExtension, 'function');
  const cli = path.join(author, 'node_modules/@colbymchenry/codegraph/dist/bin/codegraph.js');
  await run(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck', '--target', 'ES2022', '--module', 'commonjs', path.join(author, 'index.cjs')], author);
  const harness = await run(process.execPath, [cli, 'extensions', 'test', '.'], author);
  fs.writeFileSync(path.join(out, 'generated-tests.log'), harness);
  const artifact = path.join(lab, 'python-events-0.1.0.cgext');
  await run(process.execPath, [cli, 'extensions', 'pack', '.', '--out', artifact], author);
  const bytes = fs.readFileSync(artifact);
  fs.copyFileSync(artifact, path.join(out, 'python-events-0.1.0.cgext'));
  const source = fs.readFileSync(path.join(author, 'index.cjs'), 'utf8');
  assert.ok(!source.includes('require('), 'generated extension has no runtime dependency');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'checkout.events.yaml'), 'order.created: send_receipt\n');
  fs.writeFileSync(path.join(project, 'handlers.py'), 'def send_receipt():\n    return "sent"\n');
  server = await startMarketplaceServer({ database: path.join(lab, 'registry.db'), publicDirectory: path.join(repo, 'marketplace/public') });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/publish');
  await page.locator('#artifact').setInputFiles(artifact);
  for (const [id, value] of Object.entries({ name: 'Python events author starter', publisher: 'Local author validation', description: 'Generated framework extension tested outside the core repo.', source: 'https://github.com/colbymchenry/codegraph', readme: fs.readFileSync(path.join(author, 'README.md'), 'utf8') })) {
    await page.locator('#' + id).fill(value);
  }
  await page.getByRole('button', { name: 'Publish release' }).click();
  await page.waitForURL('**/extensions/python-events');
  await page.getByText('0.1.0', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, 'published.png'), fullPage: true });
  const listing = (await (await fetch(origin + '/api/extensions')).json())[0];
  assert.equal(listing.id, 'python-events'); assert.equal(listing.official, false);
  assert.equal(listing.integrity, createHash('sha256').update(bytes).digest('hex'));
  await browser.close(); browser = undefined;
  await run(process.execPath, [cli, 'extensions', 'install', origin + '/api/download/python-events/0.1.0', '--path', project]);
  let graph = await sdk.CodeGraph.open(project);
  let routes, edges;
  try {
    routes = graph.getNodesByKind('route');
    assert.equal(routes.length, 1); assert.equal(routes[0].name, 'event:order.created');
    edges = graph.getOutgoingEdges(routes[0].id).filter(e => e.metadata?.synthesizedBy === 'python-events');
    assert.equal(edges.length, 1); assert.equal(edges[0].metadata.label, 'Python event dispatch');
    assert.equal(graph.getNode(edges[0].target).name, 'send_receipt');
  } finally { graph.close(); }
  assert.ok(!fs.existsSync(path.join(project, 'package.json')), 'target remains a non-Node project');
  await run(process.execPath, [cli, 'extensions', 'remove', 'python-events', '--path', project]);
  graph = await sdk.CodeGraph.open(project);
  try { assert.deepEqual(graph.getNodesByKind('route'), []); assert.deepEqual(graph.getOutgoingEdges(routes[0].id), []); } finally { graph.close(); }
  assert.deepEqual(errors, []);
  const result = { sourceRevision: (await run('git', ['rev-parse', 'HEAD'], repo)).trim(), platform: process.platform,
    authorOutsideCore: !author.startsWith(repo + path.sep), generatedId: 'python-events',
    publicSdk: '@colbymchenry/codegraph', artifactSha256: listing.integrity,
    checks: ['generated CLI starter', 'fresh local npm package installation', 'public JSDoc typecheck', 'generated positive and negative fixture harness',
      'signed browser publisher submission', 'managed install from local release URL', 'actual event-to-Python-handler edge', 'non-Node target', 'managed removal clears contribution'],
    routes, edges, commands, browserErrors: errors };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ checks: result.checks, artifactSha256: result.artifactSha256 }));
})().catch(error => {
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, commands }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  await browser?.close(); await server?.close();
  fs.rmSync(lab, { recursive: true, force: true });
});
