/**
 * Give every engine test file a throwaway home directory (#2275).
 *
 * The suite exercises code that writes to the user's GLOBAL state: the Claude
 * prompt hook in `~/.claude/settings.json`, the daemon registry under
 * `~/.codegraph/daemons`, every agent target's global config. A test that
 * forgot to redirect the home dir wrote to the developer's real one — a
 * successful fake `codegraph upgrade` wired the prompt hook into their own
 * Claude profile, and the daemon suites left thousands of registry records
 * behind. CI never noticed: its runners have no Claude profile to edit.
 *
 * So the home dir is redirected here, before any test module loads, rather
 * than file by file. Everything that resolves a home dir is covered:
 * `os.homedir()` reads HOME on POSIX but USERPROFILE on Windows; git on
 * Windows falls back to HOMEDRIVE+HOMEPATH; the per-agent overrides
 * (CLAUDE_CONFIG_DIR, CODEX_HOME, ...) win over either, so they are cleared;
 * and git's global config is pinned to a seeded file, so a test's `git
 * commit` neither reads the developer's identity, signing or hooks nor
 * depends on them. Spawned CLI / MCP processes inherit all of it.
 *
 * Tests that redirect the home dir themselves (spying on `os.homedir`, or
 * setting HOME and restoring it) keep working: they restore to this sandbox.
 */
import { afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Resolved, so a comparison against a realpath'd cwd (macOS `/var` →
// `/private/var`) sees the same home everything else does.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-home-')));

process.env.HOME = home;
process.env.USERPROFILE = home;
if (process.platform === 'win32') {
  const drive = /^([A-Za-z]:)(\\.*)$/.exec(home);
  if (drive) {
    process.env.HOMEDRIVE = drive[1];
    process.env.HOMEPATH = drive[2];
  }
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
} else {
  // Only ever set on Windows in real life; on POSIX a stray one would point
  // the opencode/Copilot legacy-path logic somewhere real.
  delete process.env.APPDATA;
  delete process.env.LOCALAPPDATA;
}
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
for (const override of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'HERMES_HOME']) {
  delete process.env[override];
}

// Both spellings: GIT_CONFIG_GLOBAL for git >= 2.32, and `$HOME/.gitconfig`
// (the same file) for older ones.
const gitConfig = path.join(home, '.gitconfig');
fs.writeFileSync(gitConfig, '[user]\n\tname = CodeGraph Test\n\temail = test@codegraph.invalid\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;

afterAll(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a straggling child still holding a file there; it's in the temp dir */
  }
});
