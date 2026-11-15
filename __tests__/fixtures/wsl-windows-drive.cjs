/**
 * Preloaded with `--require` into a `serve --mcp` launcher a test starts: the
 * launcher, and the daemon it spawns (which inherits its node flags), take every
 * path for a Windows drive under WSL, so the index a project gets with no
 * `CODEGRAPH_DIR` is the one #995 picks: `.codegraph-wsl` once it exists.
 */
const path = require('path');

require(path.resolve(__dirname, '../../dist/sync/watch-policy.js')).__setWslWindowsDriveForTests(() => true);
