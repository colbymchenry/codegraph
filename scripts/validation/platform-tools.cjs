// Validation-only helpers. Invoke npm's JS CLI directly (npm.cmd is not an
// executable on Windows), without shell interpolation of project paths.
const fs = require('node:fs');
const path = require('node:path');
function npmCommand(args) {
  const bin = path.dirname(process.execPath);
  const candidates = [process.env.npm_execpath, process.env.NPM_CLI,
    path.join(bin, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(p => p && p.endsWith('.js') && fs.existsSync(p));
  if (!cli) throw new Error('Cannot locate npm-cli.js. Set NPM_CLI to the installed npm JavaScript entry point.');
  return [process.execPath, [cli, ...args]];
}
module.exports = { npmCommand };
