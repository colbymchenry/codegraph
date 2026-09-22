// Real SIGKILLs target ONLY children created by this disposable-project harness.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { channel } = require('node:diagnostics_channel');
const { randomUUID, createHash } = require('node:crypto');
const { CodeGraph } = require('../../dist');
const { ExtensionManager } = require('../../dist/plugins/manager');
const { recoverExtensions } = require('../../dist/plugins/recovery');
const { packageDigest } = require('../../dist/plugins/package');
const { DatabaseSync } = require('node:sqlite');
Object.assign(process.env, { CODEGRAPH_TELEMETRY: '0', CODEGRAPH_PARSE_WORKERS: '2', CODEGRAPH_RESOLVE_WORKERS: '2', CODEGRAPH_PARALLEL_RESOLVE_MIN: '0', CODEGRAPH_WASM_RELAUNCHED: '1' });
function artifact(version = '1.0.0') {
  return Buffer.from(JSON.stringify({ format: 'codegraph-extension-1', package: { name: 'recovery-demo', version, main: 'index.cjs', codegraph: { id: 'recovery-demo', apiVersion: 1, capabilities: ['frameworks'] } },
    files: { 'index.cjs': `module.exports=()=>({frameworks:[{name:'routes',languages:['python'],detect:()=>true,resolve:()=>null,extract(file){return {nodes:[{id:'plugin:recovery-demo:'+file,kind:'route',name:'/${version}',qualifiedName:file+'::route',filePath:file,language:'python',startLine:1,endLine:1,startColumn:0,endColumn:1,updatedAt:0}],references:[]}}}]});` } }));
}
function config(root) { return fs.existsSync(path.join(root, 'codegraph.json')) ? fs.readFileSync(path.join(root, 'codegraph.json'), 'utf8') : null; }
function trust(root) { const file = path.join(root, '.codegraph/plugins/trust.json'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; }
function inspect(root) {
  const dbPath = path.join(root, '.codegraph/codegraph.db');
  let routes = [];
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { routes = db.prepare("SELECT name FROM nodes WHERE kind='route' ORDER BY name").all().map(n => n.name); } finally { db.close(); }
  }
  return { initialized: fs.existsSync(dbPath), config: config(root), trust: trust(root), routes };
}
if (process.argv[2] === '--child') {
  const [root, action, boundary] = process.argv.slice(3);
  if (boundary) channel('codegraph.extension.transaction').subscribe(message => {
    if (message.phase === boundary) {
      fs.writeSync(1, JSON.stringify({ boundary, id: message.id, pid: process.pid }) + '\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  });
  (async () => {
    const manager = new ExtensionManager(root);
    if (action === 'install' || action === 'update') await manager.install({ bytes: artifact(action === 'install' ? '1.0.0' : '2.0.0') });
    else if (action === 'disable' || action === 'enable') await manager.setEnabled('recovery-demo', action === 'enable');
    else if (action === 'remove') await manager.remove('recovery-demo');
    else if (action === 'inspect') { const cg = await CodeGraph.open(root); cg.getStats(); cg.close(); }
    else if (action === 'index') { const cg = await CodeGraph.open(root); await cg.indexAll(); cg.close(); }
    else if (action === 'list') manager.list();
    else if (action === 'recover') recoverExtensions(root);
    console.log(JSON.stringify(inspect(root)));
  })().catch(error => { console.error(String(error.stack)); process.exitCode = 1; });
} else {
  const out = path.resolve(process.env.RECOVERY_OUTPUT || '.qa/recovery/process-recovery'); fs.mkdirSync(out, { recursive: true });
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kill-owned-'));
  const rows = [], processes = new Set(), commands = []; let number = 0;
  function child(root, action, boundary, cli = false) {
    const args = cli ? [path.resolve('dist/bin/codegraph.js'), 'status', root, '--json'] : [__filename, '--child', root, action, ...(boundary ? [boundary] : [])];
    const processChild = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.add(processChild);
    let stdout = '', stderr = '', resolveBoundary;
    const reached = new Promise(resolve => resolveBoundary = resolve);
    const started = Date.now();
    processChild.stdout.on('data', bytes => { stdout += bytes; if (boundary && stdout.includes('"boundary":"' + boundary + '"')) resolveBoundary(); });
    processChild.stderr.on('data', bytes => stderr += bytes);
    const done = new Promise((resolve, reject) => {
      processChild.on('error', reject);
      processChild.on('close', (exit, signal) => {
        processes.delete(processChild); const id = commands.length + 1;
        const log = path.join(out, `child-${id}.log`); fs.writeFileSync(log, stdout + stderr);
        const entry = { command: [process.execPath, ...args], pid: processChild.pid, exit, signal, seconds: (Date.now() - started) / 1000, log, sha256: createHash('sha256').update(stdout + stderr).digest('hex') };
        commands.push(entry); fs.writeFileSync(path.join(out, 'commands.json'), JSON.stringify(commands, null, 2));
        resolve({ exit, signal, stdout, stderr });
      });
    });
    return { processChild, reached, done };
  }
  async function killAt(root, action, boundary) {
    const c = child(root, action, boundary);
    let timer;
    try { await Promise.race([c.reached, c.done.then(r => { throw new Error(`Child exited before ${boundary}: ${r.stderr}`); }), new Promise((_, reject) => timer = setTimeout(() => reject(new Error('Boundary timeout: ' + boundary)), 90000))]); }
    finally { clearTimeout(timer); }
    assert.ok(processes.has(c.processChild));
    c.processChild.kill('SIGKILL');
    const result = await c.done; assert.equal(result.signal, 'SIGKILL');
    return c.processChild.pid;
  }
  async function run(root, action = 'inspect', expected = 0, cli = false) {
    const c = child(root, action, undefined, cli); let timer;
    const result = await Promise.race([c.done, new Promise((_, reject) => timer = setTimeout(() => { c.processChild.kill('SIGKILL'); reject(new Error('Owned child timeout')); }, 90000))]);
    clearTimeout(timer); assert.equal(result.exit, expected, result.stderr); return result;
  }
  async function project(old = false, initialized = true) {
    const root = path.join(lab, String(++number)); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'handlers.py'), 'def handler():\n    return "ok"\n');
    fs.writeFileSync(path.join(root, 'keep.txt'), 'unrelated bytes');
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ custom: { preserve: true } }));
    if (initialized) { const cg = await CodeGraph.init(root, { index: true }); cg.close(); }
    if (old) await new ExtensionManager(root).install({ bytes: artifact() });
    return root;
  }
  function clean(root) {
    const folder = path.join(root, '.codegraph/plugins');
    assert.ok(!fs.existsSync(path.join(folder, 'transaction.json')));
    assert.ok(!fs.existsSync(path.join(folder, 'operation.lock')));
    assert.ok(!fs.readdirSync(path.join(root, '.codegraph')).some(n => n.startsWith('extension-stage-')));
    assert.ok(!fs.readdirSync(folder).some(n => n.startsWith('stage-')));
    assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'unrelated bytes');
    const entries = JSON.parse(config(root) || '{}').plugins || [], trusted = JSON.parse(trust(root) || '{}');
    for (const entry of entries) {
      const pkg = path.join(folder, 'packages', entry.integrity);
      assert.equal(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version, entry.version);
      assert.equal(trusted[pkg], packageDigest(pkg));
    }
  }
  function receipt(value) { rows.push(value); fs.writeFileSync(path.join(out, 'matrix.json'), JSON.stringify(rows, null, 2)); console.log(JSON.stringify(value)); }
  (async () => {
    try {
      for (const action of ['install', 'update', 'disable', 'enable', 'remove']) {
        for (const boundary of ['prepared', 'config_written', 'graph_before_commit', 'graph_committed']) {
          const root = await project(action !== 'install');
          if (action === 'enable') await new ExtensionManager(root).setEnabled('recovery-demo', false);
          const before = inspect(root);
          await killAt(root, action, boundary);
          await run(root, boundary === 'prepared' ? 'list' : boundary === 'config_written' ? 'index' : 'inspect');
          const result = inspect(root), committed = boundary === 'graph_committed';
          if (!committed) { assert.equal(result.config, before.config); assert.equal(result.trust, before.trust); assert.deepEqual(result.routes, before.routes); }
          else {
            const entries = JSON.parse(result.config).plugins;
            if (action === 'remove') { assert.deepEqual(entries, []); assert.deepEqual(result.routes, []); }
            else { assert.equal(entries[0].version, action === 'update' ? '2.0.0' : '1.0.0'); assert.equal(entries[0].enabled, action !== 'disable'); assert.deepEqual(result.routes, action === 'disable' ? [] : [action === 'update' ? '/2.0.0' : '/1.0.0']); }
          }
          clean(root); await run(root, 'recover'); assert.deepEqual(inspect(root), result);
          receipt({ action, boundary, decision: committed ? 'complete' : 'rollback', repeatedRecovery: true, passed: true });
        }
      }
      for (const boundary of ['package_ready', 'trust_written']) {
        const root = await project(true), before = inspect(root);
        await killAt(root, 'update', boundary); await run(root); assert.deepEqual(inspect(root), before); clean(root);
        const packages = fs.readdirSync(path.join(root, '.codegraph/plugins/packages')); assert.equal(packages.length, 1);
        receipt({ action: 'update', boundary, decision: 'rollback and discard new package/trust', passed: true });
      }
      const first = await project(false, false);
      await killAt(first, 'install', 'graph_before_commit');
      const status = await run(first, '', 0, true); assert.equal(JSON.parse(status.stdout).initialized, false); clean(first);
      receipt({ action: 'first uninitialized install', boundary: 'graph_before_commit', entry: 'CLI status', passed: true });
      const repeated = await project(true), before = inspect(repeated);
      await killAt(repeated, 'update', 'config_written'); await killAt(repeated, 'inspect', 'recovery_config');
      await run(repeated); assert.deepEqual(inspect(repeated), before); clean(repeated);
      receipt({ action: 'kill recovery itself', boundary: 'recovery_config', decision: 'idempotent rollback', passed: true });
      const live = await project(true), c = child(live, 'update', 'config_written');
      await Promise.race([c.reached, c.done.then(r => { throw new Error('Live-owner fixture exited early: ' + r.stderr); })]);
      const lock = path.join(live, '.codegraph/plugins/operation.lock'); fs.utimesSync(lock, 1, 1);
      for (const action of ['install', 'inspect', 'index']) {
        const result = await run(live, action, 1); assert.match(result.stderr, /operation is active/);
      }
      assert.ok(processes.has(c.processChild)); c.processChild.kill('SIGKILL'); await c.done; await run(live); clean(live);
      receipt({ action: 'live aged owner', decision: 'mutation/read/index excluded; no timeout stealing', passed: true });
      const reused = await project(true), owner = path.join(reused, '.codegraph/plugins/operation.lock');
      fs.writeFileSync(owner, JSON.stringify({ format: 'codegraph-operation-lock-1', id: randomUUID(), pid: process.pid, startedAt: 1 }));
      await run(reused); clean(reused);
      fs.writeFileSync(owner, String(process.pid));
      assert.match((await run(reused, 'inspect', 1)).stderr, /legacy PID lock/); fs.unlinkSync(owner);
      const deadPid = await killAt(reused, 'update', 'prepared'); await run(reused);
      fs.writeFileSync(owner, String(deadPid)); await run(reused); clean(reused);
      receipt({ action: 'PID reuse and legacy owners', decision: 'SQLite ownership authoritative; live legacy blocked, dead legacy reclaimed', passed: true });
      const torn = await project(true); await killAt(torn, 'update', 'config_written');
      const journal = path.join(torn, '.codegraph/plugins/transaction.json'), original = fs.readFileSync(journal);
      fs.writeFileSync(path.join(torn, '.codegraph/plugins/operation.lock'), '{');
      fs.writeFileSync(journal, '{'); const state = inspect(torn);
      assert.match((await run(torn, 'inspect', 1)).stderr, /invalid transaction record/); assert.deepEqual(inspect(torn), state);
      fs.writeFileSync(journal, original); await run(torn); clean(torn);
      fs.writeFileSync(path.join(torn, '.codegraph/plugins/operation.lock'), '{');
      assert.match((await run(torn, 'inspect', 1)).stderr, /torn\/unknown owner/); fs.unlinkSync(path.join(torn, '.codegraph/plugins/operation.lock'));
      receipt({ action: 'torn records', decision: 'invalid journal/unknown owner fail closed; valid journal recovers torn owner', passed: true });
      for (const boundary of ['config_written', 'graph_committed']) {
        const edited = await project(true); await killAt(edited, 'update', boundary);
        const cfg = JSON.parse(config(edited)); cfg.userNote = 'preserve this edit'; fs.writeFileSync(path.join(edited, 'codegraph.json'), JSON.stringify(cfg));
        const t = JSON.parse(trust(edited)); t['unrelated-user-key'] = 'preserve'; fs.writeFileSync(path.join(edited, '.codegraph/plugins/trust.json'), JSON.stringify(t));
        await run(edited); assert.equal(JSON.parse(config(edited)).userNote, 'preserve this edit'); assert.equal(JSON.parse(trust(edited))['unrelated-user-key'], 'preserve'); clean(edited);
        receipt({ action: 'unrelated config/trust edits', boundary, decision: 'preserved', passed: true });
        const conflict = await project(true); await killAt(conflict, 'update', boundary);
        const cfg2 = JSON.parse(config(conflict)); cfg2.plugins[0].options = { userEdit: true }; const editedRaw = JSON.stringify(cfg2);
        fs.writeFileSync(path.join(conflict, 'codegraph.json'), editedRaw);
        assert.match((await run(conflict, 'inspect', 1)).stderr, /plugins were edited externally/); assert.equal(config(conflict), editedRaw);
        const r = JSON.parse(JSON.parse(fs.readFileSync(path.join(conflict, '.codegraph/plugins/transaction.json'))).payload);
        cfg2.plugins = JSON.parse(boundary === 'graph_committed' ? r.nextConfig : r.previousConfig).plugins; cfg2.resolvedByUser = true;
        fs.writeFileSync(path.join(conflict, 'codegraph.json'), JSON.stringify(cfg2));
        await run(conflict); clean(conflict); assert.equal(JSON.parse(config(conflict)).resolvedByUser, true);
        receipt({ action: 'conflicting plugin edit', boundary, decision: 'no overwrite; actionable repair then recovery', passed: true });
      }
      const settings = await project(true); await killAt(settings, 'update', 'config_written');
      const changedSettings = JSON.parse(config(settings)); changedSettings.exclude = ['handlers.py'];
      const changedRaw = JSON.stringify(changedSettings); fs.writeFileSync(path.join(settings, 'codegraph.json'), changedRaw);
      assert.match((await run(settings, 'inspect', 1)).stderr, /exclude was edited externally/);
      assert.equal(config(settings), changedRaw);
      delete changedSettings.exclude; fs.writeFileSync(path.join(settings, 'codegraph.json'), JSON.stringify(changedSettings));
      await run(settings); clean(settings);
      receipt({ action: 'graph-affecting external config edit', decision: 'preserved and blocked with repair instructions', passed: true });
      const tamper = await project(true); await killAt(tamper, 'update', 'graph_committed');
      const entry = JSON.parse(config(tamper)).plugins[0];
      const entryFile = path.join(tamper, '.codegraph/plugins/packages', entry.integrity, 'index.cjs'), originalEntry = fs.readFileSync(entryFile);
      fs.appendFileSync(entryFile, '\n// external change');
      assert.match((await run(tamper, 'inspect', 1)).stderr, /installed package managed:recovery-demo is missing or changed/);
      assert.ok(fs.existsSync(path.join(tamper, '.codegraph/plugins/transaction.json')));
      fs.writeFileSync(entryFile, originalEntry); await run(tamper); clean(tamper);
      receipt({ action: 'changed installed package', decision: 'trust revalidated; blocked until bytes restored', passed: true });
      const cached = await project(true), reader = await CodeGraph.open(cached);
      try {
        const node = reader.getNodesByKind('route')[0]; assert.equal(reader.getNode(node.id).name, '/1.0.0');
        await killAt(cached, 'update', 'graph_committed'); await run(cached); clean(cached);
        assert.equal(reader.getNode(node.id).name, '/2.0.0');
      } finally { reader.close(); }
      receipt({ action: 'long-lived reader after fresh-process recovery', decision: 'old cached node invalidated by commit marker', passed: true });
      fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ platform: process.platform, node: process.version, rows, commands: commands.length }, null, 2));
    } finally {
      for (const c of processes) c.kill('SIGKILL');
      if (processes.size) await new Promise(resolve => setTimeout(resolve, 300));
      fs.rmSync(lab, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
