/**
 * A daemon of a release from before an index had names of its own. Whatever
 * index it serves, it listens on the socket it is given (in practice the
 * tmpdir fallback named after the project root), holds that index's daemon
 * lock, files its registry record under the root with no index directory, and
 * answers the hello, keeping each connection open as a daemon does. On SIGTERM
 * it shuts down as that release does: its lock goes while it names this
 * daemon, and its record and its socket go whatever they hold. Given `stuck`,
 * it ignores SIGTERM instead, as a daemon wedged in its shutdown does, so only
 * SIGKILL stops it and everything it made stays behind.
 *
 *   node older-release-daemon.cjs <index dir> <version> <socket path> <registry file> [stuck]
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const [indexDir, version, socketPath, recordFile, stuck] = process.argv.slice(2);
const lockFile = path.join(indexDir, 'daemon.pid');
const lock = { pid: process.pid, version, socketPath, startedAt: Date.now() };
const connections = new Set();

const server = net.createServer((socket) => {
  // A daemon reads what a client sends, and outlives one that hangs up at once.
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
  socket.on('error', () => {});
  socket.resume();
  socket.write(JSON.stringify({ codegraph: version, pid: process.pid, socketPath, protocol: 1 }) + '\n');
});
server.listen(socketPath, () => {
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, JSON.stringify({ root: path.dirname(indexDir), ...lock }, null, 2) + '\n');
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
});
process.on('SIGTERM', () => {
  if (stuck === 'stuck') return;
  for (const socket of connections) socket.destroy();
  server.close(() => {
    try {
      if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === process.pid) fs.unlinkSync(lockFile);
    } catch { /* already gone */ }
    for (const file of [recordFile, socketPath]) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
    process.exit(0);
  });
});
