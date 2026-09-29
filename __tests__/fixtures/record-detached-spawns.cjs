/**
 * Preloaded with `--require` into the `serve --mcp` launchers a test starts, so
 * the test learns the pid of every detached daemon candidate they spawn
 * (#1773). Racing launchers may each spawn one; the losers exit on their own
 * once they see the winner's lock, but on a loaded machine one can still be
 * starting when the test tears down. Written synchronously at spawn time, so
 * the pid is on disk before the launcher can be stopped. Candidates inherit
 * the preload through `process.execArgv`; they spawn nothing detached.
 */
const childProcess = require('child_process');
const fs = require('fs');

const log = process.env.CG_TEST_SPAWN_LOG;
if (log) {
  const spawn = childProcess.spawn;
  childProcess.spawn = function recordDetached(...args) {
    const child = spawn.apply(this, args);
    const options = args.find((arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg));
    if (options && options.detached && child.pid) fs.appendFileSync(log, `${child.pid}\n`);
    return child;
  };
}
