'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Observe a real post-registration write, not an event raced against startup.
 * Native watcher registration can cross an event-loop/thread boundary. Keep
 * generating distinct writes within a fixed deadline; a timer never counts as
 * success, and no event on an unrelated path can satisfy the probe.
 */
function watchProbe(project, {
  watch = fs.watch, writeFileSync = fs.writeFileSync,
  recursive = process.platform !== 'linux', timeoutMs = 10000, intervalMs = 200,
  timers = {setTimeout, clearTimeout, setInterval, clearInterval},
} = {}) {
  return new Promise((resolve, reject) => {
    const marker = 'runtime-watch-probe.txt';
    let watcher, deadline, writes, finished = false, sequence = 0;
    const finish = error => {
      if (finished) return;
      finished = true;
      if (deadline !== undefined) timers.clearTimeout(deadline);
      if (writes !== undefined) timers.clearInterval(writes);
      watcher?.close();
      if (error) reject(error); else resolve();
    };
    try {
      watcher = watch(project, {recursive}, (_event, filename) => {
        if (filename && path.basename(String(filename)) === marker) finish();
      });
      watcher.on('error', finish);
      deadline = timers.setTimeout(() => finish(new Error('native file-watch event missing')), timeoutMs);
      // No synchronous creation immediately after fs.watch(). The first write
      // yields to registration; later distinct writes cover native readiness.
      writes = timers.setInterval(() => {
        if (finished) return;
        try { writeFileSync(path.join(project, marker), `event probe ${++sequence}\n`); }
        catch (error) { finish(error); }
      }, intervalMs);
    } catch (error) { finish(error); }
  });
}
module.exports = {watchProbe};
