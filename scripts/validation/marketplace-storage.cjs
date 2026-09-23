// Real subprocess persistence/atomicity tests. Kills only children created here.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { generateKeyPairSync, randomUUID, sign, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const storage = require('../../dist/plugins/marketplace-storage');
const { createMarketplaceStore } = require('../../dist/plugins/marketplace');
const childMode = process.argv[2];
if (childMode === 'publish-child') {
  const [database, input, pause, ready] = process.argv.slice(3);
  if (pause) require('node:diagnostics_channel').channel('codegraph.marketplace.publication').subscribe(event => {
    if (event.phase === pause) { fs.writeFileSync(ready, JSON.stringify(event)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); }
  });
  const store = createMarketplaceStore(database);
  try { console.log(JSON.stringify(store.submit(JSON.parse(fs.readFileSync(input))))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { store.close(); }
} else main().catch(e => { console.error(e.stack); process.exitCode = 1; });
async function main() {
  const out = path.resolve(process.env.STORAGE_OUTPUT || '.qa/hosting/storage'); fs.mkdirSync(out, { recursive: true });
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-registry-storage-')), children = new Set(), checks = [], receipts = [];
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const owner = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const volume = path.join(lab, 'volume');
  function save() { fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ revision, platform: process.platform, arch: process.arch, checks, receipts }, null, 2)); }
  function passed(name) { checks.push(name); save(); console.log('PASS', name); }
  function submission(id, version, keys = owner) {
    const bytes = Buffer.from(JSON.stringify({ format: 'codegraph-extension-1', package: { name: '@storage/'+id, version, main: 'index.cjs', codegraph: { id, apiVersion: 1, capabilities: ['frameworks'] } }, files: { 'index.cjs': 'module.exports=()=>({frameworks:[]})' } }));
    const payload = JSON.stringify({ name: id, publisher: 'Storage validation', description: 'Disposable registry test', readme: 'Test', source: 'https://example.com/source', artifact: bytes.toString('base64'), timestamp: Date.now(), nonce: randomUUID() });
    return { payload, publicKey: keys.publicKey.export({ format: 'jwk' }), signature: sign('sha256', Buffer.from(payload), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') };
  }
  function child(args, env = {}, cwd = root) {
    const record = { command: [process.execPath, ...args], started: new Date().toISOString(), cwd, env };
    const proc = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] });
    children.add(proc); let stdout = '', stderr = '';
    proc.stdout.on('data', b => stdout += b); proc.stderr.on('data', b => stderr += b);
    const done = new Promise(resolve => {
      proc.on('error', e => stderr += String(e));
      proc.on('close', (exit, signal) => { children.delete(proc); const number = receipts.length + 1, log = `${number}.log`;
        fs.writeFileSync(path.join(out, log), stdout + stderr);
        Object.assign(record, { exit, signal, finished: new Date().toISOString(), log, sha256: createHash('sha256').update(stdout+stderr).digest('hex') }); receipts.push(record); save(); resolve({ exit, signal, stdout, stderr }); });
    });
    return { proc, done, stdout: () => stdout };
  }
  async function waitFor(predicate) { const until = Date.now()+20000; while (!predicate()) { if (Date.now()>until) throw Error('Timed out waiting for isolated child boundary'); await new Promise(r=>setTimeout(r,25)); } }
  function publish(id, version, pause = '', keys) {
    const input = path.join(lab, randomUUID()+'.json'), ready = input+'.ready'; fs.writeFileSync(input, JSON.stringify(submission(id, version, keys)));
    return { ...child([__filename, 'publish-child', path.join(volume,'registry.sqlite'), input, pause, ready]), ready, input };
  }
  function releases(id) { const s = createMarketplaceStore(path.join(volume,'registry.sqlite')); try { return s.releases(id); } finally { s.close(); } }
  async function server(directory, cwd) {
    const c = child([path.join(root,'marketplace/server/registry.cjs'), 'serve'], { MARKETPLACE_DATA_DIR: directory, PORT: '0' }, cwd);
    await waitFor(()=>c.stdout().includes('"ready":true'));
    const { port } = JSON.parse(c.stdout().trim().split('\n')[0]); return { ...c, origin: `http://127.0.0.1:${port}` };
  }
  try {
    assert.throws(()=>storage.openMarketplaceVolume(volume)); assert.ok(!fs.existsSync(volume)); passed('missing volume fails closed without creating an empty registry');
    const initialized = storage.initializeMarketplaceVolume(volume);
    assert.throws(()=>storage.initializeMarketplaceVolume(volume), /empty/);
    const first = publish('atomic-demo','1.0.0','before-commit'); await waitFor(()=>fs.existsSync(first.ready));
    // A reader in another connection cannot observe the uncommitted listing.
    const { DatabaseSync } = require('node:sqlite'); const read = new DatabaseSync(initialized.database, { readOnly: true });
    assert.equal(read.prepare('SELECT count(*) AS n FROM releases').get().n, 0); read.close();
    first.proc.kill('SIGKILL'); assert.equal((await first.done).signal,'SIGKILL'); assert.deepEqual(releases('atomic-demo'),[]);
    passed('kill before commit leaves no visible owner/listing/artifact/replay record');
    // Retry the exact signed submission: a rolled-back nonce must be retryable.
    assert.equal((await child([__filename,'publish-child',initialized.database,first.input,'','']).done).exit,0);
    assert.equal((await child([__filename,'publish-child',initialized.database,first.input,'','']).done).exit,1);
    passed('rolled-back submission can retry once; committed replay is rejected');
    const committed = publish('atomic-demo','2.0.0','after-commit'); await waitFor(()=>fs.existsSync(committed.ready));
    committed.proc.kill('SIGKILL'); assert.equal((await committed.done).signal,'SIGKILL');
    assert.equal(storage.verifyMarketplaceDatabase(initialized.database).releases.length,2); passed('kill after commit retains verified package and listing');
    const same = await Promise.all([publish('atomic-demo','3.0.0').done,publish('atomic-demo','3.0.0').done]);
    assert.deepEqual(same.map(r=>r.exit).sort(),[0,1]); assert.equal(releases('atomic-demo').length,3); passed('concurrent immutable version writers commit exactly one release');
    const stranger = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const race = await Promise.all([publish('race-demo','1.0.0').done,publish('race-demo','2.0.0','',stranger).done]);
    assert.deepEqual(race.map(r=>r.exit).sort(),[0,1]); assert.equal(releases('race-demo').length,1); passed('concurrent publisher ownership claim has one winner');
    const before = storage.verifyMarketplaceDatabase(initialized.database);
    const live = await server(volume,lab), catalog = await (await fetch(live.origin+'/api/extensions')).json();
    live.proc.kill('SIGKILL'); await live.done;
    const restart = await server(volume,os.tmpdir());
    assert.deepEqual(await (await fetch(restart.origin+'/api/extensions')).json(),catalog);
    assert.equal(storage.openMarketplaceVolume(volume).id,initialized.id); passed('fresh production process and different deployment cwd preserve catalog/identity/artifacts');
    const backup = path.join(lab,'backup'); storage.backupMarketplaceVolume(volume,backup);
    const pending = publish('in-flight-demo','1.0.0','before-commit'); await waitFor(()=>fs.existsSync(pending.ready));
    const concurrentBackup = path.join(lab,'concurrent-backup'); storage.backupMarketplaceVolume(volume,concurrentBackup);
    pending.proc.kill('SIGKILL'); await pending.done;
    assert.deepEqual(storage.verifyMarketplaceDatabase(path.join(concurrentBackup,'registry.sqlite')),before);
    passed('backup concurrent with uncommitted publication captures only complete releases');
    const restored = path.join(lab,'restored'); storage.restoreMarketplaceVolume(backup,restored);
    assert.deepEqual(storage.verifyMarketplaceDatabase(path.join(restored,'registry.sqlite')),before);
    const isolated = await server(restored,lab);
    for (const release of before.releases) {
      const bytes = Buffer.from(await (await fetch(isolated.origin+`/api/download/${release.id}/${release.version}`)).arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'),release.integrity);
    }
    passed('online WAL backup restores listing/bytes/ownership into isolated serving process');
    assert.throws(()=>storage.restoreMarketplaceVolume(backup,volume)); assert.throws(()=>storage.backupMarketplaceVolume(volume,backup));
    assert.deepEqual(storage.verifyMarketplaceDatabase(initialized.database),before); passed('restore/backup cannot overwrite existing live data');
    const r = createMarketplaceStore(path.join(restored,'registry.sqlite'));
    try { assert.throws(()=>r.submit(submission('atomic-demo','4.0.0',stranger)),/another publisher/); r.submit(submission('atomic-demo','4.0.0')); }
    finally { r.close(); }
    assert.equal(releases('atomic-demo').length,3); passed('restored publisher ownership persists and restored writes are isolated');
    const corrupt = path.join(lab,'corrupt'); fs.cpSync(backup,corrupt,{recursive:true}); fs.appendFileSync(path.join(corrupt,'registry.sqlite'),'corrupt');
    assert.throws(()=>storage.restoreMarketplaceVolume(corrupt,path.join(lab,'never-created')),/checksum/); assert.ok(!fs.existsSync(path.join(lab,'never-created'))); passed('corrupt backup rejected before creating destination');
    const marker = path.join(restored,'registry-volume.json'); fs.writeFileSync(marker,JSON.stringify({format:1,id:randomUUID(),database:'registry.sqlite'}));
    assert.throws(()=>storage.openMarketplaceVolume(restored),/identity mismatch/); passed('wrong mounted registry identity fails closed');
    for (const instance of [restart,isolated]) { instance.proc.kill('SIGTERM'); const stopped = await instance.done; if (process.platform === 'win32') assert.equal(stopped.signal,'SIGTERM'); else assert.equal(stopped.exit,0); }
    fs.writeFileSync(path.join(out,'success.json'),JSON.stringify({revision,checks:checks.length,success:true}));
  } finally { for (const proc of children) proc.kill('SIGKILL'); await new Promise(r=>setTimeout(r,100)); fs.rmSync(lab,{recursive:true,force:true}); }
}
