// Test-only native runner: durable receipts, real OS metadata, no release commands.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { npmCommand } = require('./platform-tools.cjs');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.NATIVE_OUTPUT || `.qa/release-native/${process.platform}-${process.arch}`);
fs.mkdirSync(out, { recursive: true });
const version = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const metadata = { revision: version, platform: process.platform, arch: process.arch, release: os.release(),
  scope: process.env.NATIVE_VALIDATION_SCOPE || 'full', notRun: [],
  node: process.version, runnerOS: process.env.RUNNER_OS, runnerArch: process.env.RUNNER_ARCH,
  imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
  githubRun: process.env.GITHUB_RUN_ID, githubAttempt: process.env.GITHUB_RUN_ATTEMPT,
  started: new Date().toISOString(), steps: [] };
function save() { fs.writeFileSync(path.join(out, 'summary.json.tmp'), JSON.stringify(metadata, null, 2)); fs.renameSync(path.join(out, 'summary.json.tmp'), path.join(out, 'summary.json')); }
save();
const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_PARSE_WORKERS: '2', CODEGRAPH_RESOLVE_WORKERS: '2', CODEGRAPH_PARALLEL_RESOLVE_MIN: '0',
  RECOVERY_OUTPUT: path.join(out, 'recovery'), AUTHOR_OUTPUT: path.join(out, 'author'), COMPAT_OUTPUT: path.join(out, 'compatibility'), BROWSER_OUTPUT: path.join(out, 'browser') };
async function run(name, command, args, timeout = 360000, overrides = {}) {
  const step = { name, command: [command, ...args], cwd: root, revision: version, overrides, started: new Date().toISOString(), status: 'running' };
  metadata.steps.push(step); save(); console.log('START', name);
  const logFile = path.join(out, name + '.log'); const log = fs.openSync(logFile, 'w');
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', log, log], timeout });
    let error;
    child.on('error', e => error = String(e));
    child.on('close', (exit, signal) => resolve({ exit, signal, error }));
  });
  fs.fsyncSync(log); fs.closeSync(log);
  Object.assign(step, result, { status: result.exit === 0 ? 'passed' : 'failed', seconds: (Date.now() - started) / 1000,
    finished: new Date().toISOString(), log: name + '.log', sha256: createHash('sha256').update(fs.readFileSync(logFile)).digest('hex') });
  save(); console.log('END', name, step.status, step.seconds);
  if (step.status === 'failed') console.log(fs.readFileSync(logFile, 'utf8').split('\n').slice(-65).join('\n'));
  return step.status === 'passed';
}
(async () => {
  const built = await run('build', ...npmCommand(['run', 'build']));
  if (built && metadata.scope === 'repairs') {
    metadata.notRun = ['unchanged core/worker/lifecycle paths: reuse successful steps at 90516f8, run 35880834124'];
    await run('focused', process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '__tests__/db-reopen-on-replace.test.ts', '__tests__/upgrade.test.ts', '__tests__/cli-ui-command.test.ts', '--maxWorkers=1', '--minWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${path.join(out, 'focused.json')}`], 300000);
    await run('file-growth-race', process.execPath, ['scripts/validation/release-size-race.cjs','dist']);
    await run('installer-archives', process.execPath, ['scripts/validation/release-installers.cjs']);
    await run('security-negative', process.execPath, ['scripts/validation/release-security.cjs','.','dist']);
  } else if (built) {
    await run('focused', process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
      '__tests__/watcher-replaced-db.test.ts', '__tests__/schemaless-db-not-initialized.test.ts', '__tests__/liveness-watchdog.test.ts',
      '__tests__/mpeg-ts-not-typescript.test.ts', '__tests__/oversize-file-not-read.test.ts', '__tests__/bounded-source.test.ts',
      '__tests__/dominant-file-cache.test.ts', '__tests__/cli-ui-command.test.ts', '__tests__/upgrade.test.ts', '__tests__/npm-shim.test.ts',
      '__tests__/release-trust-boundaries.test.ts', '__tests__/security.test.ts', '__tests__/db-reopen-on-replace.test.ts',
      '__tests__/foundation.test.ts', '__tests__/concurrent-locking.test.ts', '__tests__/sync.test.ts', '__tests__/extension-sync.test.ts',
      '__tests__/extension-trust.test.ts', '__tests__/extension-releases.test.ts', '__tests__/extension-author.test.ts',
      '--maxWorkers=1', '--minWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${path.join(out, 'focused.json')}`], 900000);
    await run('first-wave', process.execPath, ['scripts/validation/release-first-wave.cjs','dist']);
    await run('file-growth-race', process.execPath, ['scripts/validation/release-size-race.cjs','dist']);
    await run('security-negative', process.execPath, ['scripts/validation/release-security.cjs','.','dist']);
    await run('installer-archives', process.execPath, ['scripts/validation/release-installers.cjs']);
    await run('picomatch', process.execPath, ['scripts/validation/release-picomatch.cjs']);
    await run('compiled-workers', process.execPath, ['--test','scripts/validation/extensions-runtime.test.cjs']);
    await run('native-paths', process.execPath, ['scripts/validation/native-paths.cjs']);
    await run('semantic-recovery', process.execPath, ['scripts/validation/semantic-update-recovery.cjs'], 240000, {SEMANTIC_RECOVERY_OUTPUT:path.join(out,'semantic-recovery')});
    await run('managed-recovery', process.execPath, ['scripts/validation/extensions-recovery.cjs'], 600000);
    await run('managed-recovery-override', process.execPath, ['scripts/validation/extensions-recovery.cjs'], 600000, {CODEGRAPH_DIR:'.codegraph-native',RECOVERY_OUTPUT:path.join(out,'recovery-override')});
  }
  metadata.finished = new Date().toISOString(); metadata.success = built && metadata.steps.every(s=>s.status==='passed');save();process.exitCode=metadata.success?0:1;
})().catch(error=>{metadata.failure=String(error.stack);save();console.error(error);process.exitCode=1;});
