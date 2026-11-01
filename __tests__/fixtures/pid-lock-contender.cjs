/** Pause a real PID-lock mutation after its final check, before unlink/rename. */
const fs = require('fs');
const path = require('path');
const [dist, root, operation, markers] = process.argv.slice(2);
if (operation === 'hold-barrier') {
  const { FileLock } = require(path.join(dist, 'utils.js'));
  const pidPath = path.join(root, '.codegraph', fs.readFileSync(path.join(markers, 'name'), 'utf8'));
  const initial = fs.readFileSync(pidPath, 'utf8');
  const barrier = new FileLock(`${pidPath}.break`);
  barrier.acquire();
  fs.writeFileSync(path.join(markers, 'paused'), String(process.pid));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path.join(markers, 'invoke'))) {
    if (Date.now() > deadline) throw new Error('Owner mutation was never invoked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  // A separate process must release the barrier while the owner is synchronously
  // waiting. The short hold also detects mutations that ignore the barrier.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const unchanged = fs.existsSync(pidPath) && fs.readFileSync(pidPath, 'utf8') === initial;
  barrier.release();
  fs.writeFileSync(path.join(markers, 'result'), JSON.stringify({ unchanged }));
  process.exit(0);
}
const writer = require(path.join(dist, 'mcp/writer-lock.js'));
const daemon = operation.startsWith('daemon') ? require(path.join(dist, 'mcp/daemon.js')) : null;
const registry = operation === 'daemon-cleanup' ? require(path.join(dist, 'mcp/daemon-registry.js')) : null;
const dead = 99999999;
const name = operation === 'rebuild' ? 'rebuild.pid' : operation.startsWith('daemon') ? 'daemon.pid' : 'writer.pid';
const pidPath = path.join(root, '.codegraph', name);
const own = ['ready', 'release', 'daemon-refresh', 'daemon-exit'].includes(operation);
const record = operation.startsWith('daemon')
  ? { pid: own ? process.pid : dead, version: '1.0.0', socketPath: path.join(root, 'unused.sock'), startedAt: 1 }
  : { pid: own ? process.pid : dead, mode: 'direct', startedAt: 1 };
fs.writeFileSync(pidPath, JSON.stringify(record) + '\n');
const shutdownSocket = path.join(root, 'shutdown.sock');
if (operation === 'daemon-exit') {
  fs.writeFileSync(writer.getWriterPidPath(root), JSON.stringify({ pid: process.pid, mode: 'daemon', startedAt: 1 }));
  fs.writeFileSync(shutdownSocket, 'departing daemon');
}

const unlink = fs.unlinkSync;
const rename = fs.renameSync;
let paused = false;
function pause() {
  if (paused) return;
  paused = true;
  fs.writeFileSync(path.join(markers, 'paused'), String(process.pid));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path.join(markers, 'go'))) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for competing mutation');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
fs.unlinkSync = function (file) {
  if (String(file) === (operation === 'daemon-exit' ? shutdownSocket : pidPath)) pause();
  return unlink.apply(this, arguments);
};
fs.renameSync = function (from, to) {
  if (String(to) === pidPath) pause();
  return rename.apply(this, arguments);
};

async function run() {
  let acquired = false;
  switch (operation) {
    case 'writer': case 'rebuild':
      acquired = writer.tryAcquireWriterLock(root, 'slow', name).kind === 'acquired';
      break;
    case 'swap':
      acquired = writer.swapWriterLock(root, dead, { pid: process.pid, mode: 'slow', startedAt: 2 });
      break;
    case 'ready':
      writer.markWriterReady(root);
      acquired = writer.readWriterLock(root)?.pid === process.pid;
      break;
    case 'release':
      writer.releaseWriterLock(root);
      break;
    case 'daemon':
      daemon.clearStaleDaemonLock(pidPath, dead);
      acquired = daemon.tryAcquireDaemonLock(root).kind === 'acquired';
      break;
    case 'daemon-refresh':
      daemon.refreshDaemonLock(pidPath, fs.readFileSync(pidPath, 'utf8'), { ...record, startedAt: 2 });
      acquired = true;
      break;
    case 'daemon-cleanup':
      await registry.clearStaleDaemonArtifacts(root);
      break;
    case 'daemon-exit': {
      const departing = new daemon.Daemon(root);
      departing.socketPath = shutdownSocket;
      // Exercise real shutdown without starting a server or initializing an index.
      process.exit = (code) => {
        if (code !== 0) throw new Error(`Unexpected daemon exit ${code}`);
      };
      await departing.stop('test');
      break;
    }
    default: throw new Error(`Unknown operation ${operation}`);
  }
  if (!paused) throw new Error('Mutation never reached the expected filesystem seam');
  fs.writeFileSync(path.join(markers, 'result'), JSON.stringify({ acquired }));
  // Stay alive with any successful claim until the parent checks its ownership.
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
}
run().catch((error) => { console.error(error); process.exit(2); });
