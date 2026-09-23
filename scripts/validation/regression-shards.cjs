// Four sequential full-suite shards, resumable only with matching receipts.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const out = path.resolve(process.env.REGRESSION_OUTPUT || '.qa/native-linux'); fs.mkdirSync(out, { recursive: true });
const revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const source = revision(), results = [];
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function write(file, data) { fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2)); fs.renameSync(file + '.tmp', file); }
function expectedFiles(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? expectedFiles(path.join(dir, d.name)) : d.name.endsWith('.test.ts') ? [path.resolve(dir, d.name)] : []); }
(async () => {
  for (let shard = 1; shard <= 4; shard++) {
    if (revision() !== source) throw new Error('HEAD changed during shards; completed receipts retained; refuse a mixed-revision total');
    const stem = path.join(out, `shard-${shard}`), report = stem + '.tests.json', file = stem + '.json', logFile = stem + '.log';
    if (process.argv.includes('--resume') && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file));
      if (saved.revision === source && saved.exit === 0 && digest(report) === saved.reportHash && digest(logFile) === saved.logHash) {
        results.push(saved); console.log('REUSE', shard); continue;
      }
      throw new Error('Existing receipt is not a verified successful shard of this revision; choose a new REGRESSION_OUTPUT');
    }
    if (fs.existsSync(file) || fs.existsSync(stem + '.started.json')) throw new Error('Prior attempt exists; inspect it and select a new output directory rather than overwrite evidence');
    const args = ['node_modules/vitest/vitest.mjs', 'run', `--shard=${shard}/4`, '--maxWorkers=2', '--minWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
    const receipt = { revision: source, shard, command: [process.execPath, ...args], platform: process.platform, arch: process.arch, node: process.version, release: os.release(), started: new Date().toISOString() };
    write(stem + '.started.json', receipt); const started = Date.now(), fd = fs.openSync(logFile, 'w'); console.log('START', shard);
    const status = await new Promise(resolve => {
      const child = spawn(process.execPath, args, { stdio: ['ignore', fd, fd], timeout: 600000 });
      let error; child.on('error', e => error = String(e)); child.on('close', (exit, signal) => resolve({ exit, signal, error }));
    });
    fs.fsyncSync(fd); fs.closeSync(fd);
    Object.assign(receipt, status, { seconds: (Date.now() - started) / 1000, finished: new Date().toISOString(), logHash: digest(logFile) });
    if (fs.existsSync(report)) {
      const r = JSON.parse(fs.readFileSync(report));
      Object.assign(receipt, { reportHash: digest(report), passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests, files: r.testResults.map(f => f.name) });
    } else receipt.incomplete = 'Vitest JSON result missing';
    write(file, receipt); results.push(receipt); write(path.join(out, 'checkpoint.json'), { revision: source, results });
    console.log('END', shard, JSON.stringify(receipt));
  }
  const expected = expectedFiles('__tests__').sort(), actual = results.flatMap(r => r.files || []).sort();
  const counts = actual.reduce((m, f) => (m[f] = (m[f] || 0) + 1, m), {});
  const missing = expected.filter(f => !counts[f]), duplicate = Object.keys(counts).filter(f => counts[f] !== 1), unexpected = actual.filter(f => !expected.includes(f));
  const aggregate = { revision: source, results, expectedFiles: expected.length, observedFiles: actual.length, missing, duplicate, unexpected,
    passed: results.reduce((n, r) => n + (r.passed || 0), 0), failed: results.reduce((n, r) => n + (r.failed || 0), 0), skipped: results.reduce((n, r) => n + (r.skipped || 0), 0) };
  aggregate.success = results.length === 4 && results.every(r => r.exit === 0 && !r.incomplete) && !missing.length && !duplicate.length && !unexpected.length;
  write(path.join(out, 'result.json'), aggregate); console.log(JSON.stringify(aggregate)); process.exitCode = aggregate.success ? 0 : 1;
})().catch(error => { write(path.join(out, 'incomplete.json'), { revision: source, error: String(error.stack), results }); console.error(error); process.exitCode = 1; });
