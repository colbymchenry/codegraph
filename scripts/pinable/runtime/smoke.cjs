'use strict';
// Invoked by the archive's Node, after extracting into a Unicode/spaces path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createInterface } = require('node:readline');

async function main() {
  const bundle = path.resolve(process.argv[2]);
  const meta = JSON.parse(fs.readFileSync(path.join(bundle, 'runtime.json'), 'utf8'));
  assert.equal(process.version, meta.source.nodeVersion);
  assert.equal(`${process.platform}-${process.arch}`, meta.target);
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(path.join(bundle, meta.nodeExecutable)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pinable-smoke-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'pinable 项目 with spaces-'));
  let server;
  let graph;
  try {
    Object.assign(process.env, {HOME: home, USERPROFILE: home, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1'});
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE smoke USING fts5(content)');
    db.close();
    // Exercise the native watcher on the original (possibly 8.3) temp path.
    // Do not canonicalize the fixture or disable watching to hide libuv aborts.
    await require('./watch-probe.cjs').watchProbe(project);
    const lib = path.join(bundle, 'lib');
    const { getKernel } = require(path.join(lib, 'dist/extraction/kernel/loader.js'));
    const kernel = getKernel();
    assert.ok(kernel, 'native kernel failed to load/verify; WASM fallback is not acceptance');
    assert.ok(kernel.contractInfo().languages.includes('typescript'));
    const source = 'export function desktopGreeting(): string { return "Pinable"; }\n';
    const extracted = kernel.extractFile('hello.ts', source, 'typescript');
    assert.ok(extracted.nodes.length > 0, 'native extraction produced no nodes');
    fs.writeFileSync(path.join(project, 'hello.ts'), source);
    const { CodeGraph } = require(path.join(lib, 'dist/index.js'));
    graph = await CodeGraph.init(project, {index: true});
    assert.ok(graph.getNodesByKind('function').some(node => node.name === 'desktopGreeting'));
    fs.appendFileSync(path.join(project, 'hello.ts'), '\nexport function desktopIncremental() { return desktopGreeting(); }\n');
    await graph.sync();
    assert.ok(graph.getNodesByKind('function').some(node => node.name === 'desktopIncremental'));
    graph.close(); graph = null;
    const launcher = path.join(bundle, meta.entrypoint);
    const version = spawnSync(launcher, ['--version'], {cwd: project, env: process.env, encoding: 'utf8', timeout: 30000});
    assert.ifError(version.error);
    assert.equal(version.status, 0, version.stderr);
    assert.ok(version.stdout.includes(meta.source.version));
    const invalid = spawnSync(launcher, ['--pinable-intentionally-unknown-option'], {cwd: project, env: process.env, encoding: 'utf8', timeout: 30000});
    assert.ifError(invalid.error);
    assert.notEqual(invalid.status, 0, 'launcher must preserve failure exit status');
    server = spawn(launcher, ['serve', '--mcp'], {cwd: project, env: process.env, stdio: ['pipe', 'pipe', 'pipe']});
    let errors = '';
    let invalidLine = '';
    const pending = new Map();
    server.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-12000); });
    const lines = createInterface({input: server.stdout});
    lines.on('line', line => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        if (pending.has(message.id)) pending.get(message.id)(message);
      } catch { invalidLine = line; }
    });
    const exit = new Promise((resolve, reject) => { server.once('error', reject); server.once('exit', resolve); });
    let sequence = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout: ${errors}`)); }, 30000);
      pending.set(id, message => { clearTimeout(timer); pending.delete(id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
      server.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    });
    const initialize = await rpc('initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'pinable-runtime-smoke', version: '1.0.0'}, rootUri: pathToFileURL(project).href});
    assert.equal(initialize.serverInfo.name, 'codegraph');
    server.stdin.write(JSON.stringify({jsonrpc:'2.0', method:'notifications/initialized', params:{}}) + '\n');
    const tools = await rpc('tools/list', {});
    assert.ok(tools.tools.some(tool => tool.name === 'codegraph_explore'));
    assert.equal(invalidLine, '', 'MCP stdout must contain only JSON-RPC');
    server.stdin.end();
    let shutdown;
    try {
      await Promise.race([exit, new Promise((_, reject) => { shutdown = setTimeout(() => reject(new Error('MCP did not stop on stdin EOF')), 15000); })]);
    } finally { clearTimeout(shutdown); }
    assert.equal(server.exitCode, 0, errors);
    server = null;
    console.log(JSON.stringify({ok: true, target: meta.target, revision: meta.source.revision, node: process.version, kernel: kernel.contractInfo().kernelVersion}));
  } finally {
    graph?.close();
    if (server && server.exitCode === null) {
      const stopped = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGKILL');
      await stopped;
    }
    fs.rmSync(project, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
    fs.rmSync(home, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
