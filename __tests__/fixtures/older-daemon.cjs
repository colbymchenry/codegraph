/**
 * A daemon of an older release, listening where a current launcher does not
 * look (#2335). On Windows, daemons before #2278 named their pipe after the
 * project root as typed, so a newer launcher's probe never reaches them and
 * only the project lock says where they are. Like a real daemon it holds the
 * project's daemon and writer locks and answers the hello; on SIGTERM it lets
 * go of whichever of the two locks still names it and exits, the shape of a
 * real daemon's shutdown. (On Windows SIGTERM is TerminateProcess, and the
 * stop clears what is left.)
 *
 *   node older-daemon.cjs <project root> <version> <socket path>
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const [root, version, socketPath] = process.argv.slice(2);
const dir = path.join(root, '.codegraph');
const writeLock = (name, record) => fs.writeFileSync(path.join(dir, name), JSON.stringify(record) + '\n');

const server = net.createServer((socket) => {
  socket.end(JSON.stringify({ codegraph: version, pid: process.pid, socketPath, protocol: 1 }) + '\n');
});
server.listen(socketPath, () => {
  writeLock('writer.pid', { pid: process.pid, mode: 'daemon', startedAt: Date.now(), ready: true });
  writeLock('daemon.pid', { pid: process.pid, version, socketPath, startedAt: Date.now() });
});
process.on('SIGTERM', () => {
  for (const name of ['writer.pid', 'daemon.pid']) {
    const file = path.join(dir, name);
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
    } catch { /* already gone */ }
  }
  server.close(() => process.exit(0));
});
