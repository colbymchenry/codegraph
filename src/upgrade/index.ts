/**
 * `codegraph upgrade`
 *
 * Self-update for the CLI, whatever way it was installed:
 *
 *   - **bundle** — the self-contained runtime+app installed by `install.sh`
 *     (Linux/macOS) or `install.ps1` (Windows). Upgrading re-runs the SAME
 *     canonical installer script (single source of truth) so the download /
 *     version-resolution / PATH logic never drifts between first-install and
 *     upgrade.
 *   - **npm** — installed via `npm i -g @colbymchenry/codegraph`. Upgrading
 *     shells out to npm.
 *   - **npx** — ephemeral; nothing to upgrade (next `npx` fetches latest).
 *   - **source** — a git checkout running its own `dist/`; `git pull` + rebuild.
 *
 * Detection is structural (see `detectInstallMethod`): a bundle carries a
 * vendored `node` binary and a `bin/codegraph` launcher next to its `lib/`, so
 * we can recognize it from the running file's path without a marker file.
 *
 * Windows wrinkle: a running `node.exe` is locked and can't be deleted, so the
 * bundle's `current\` dir can't be overwritten in place by the process doing
 * the upgrade. We therefore spawn a DETACHED helper that waits for this
 * process to exit (releasing the lock), then runs `install.ps1`. This is the
 * conventional Windows self-update dance (rustup/nvm-windows do the same).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { spawnSync } from 'child_process';

export const REPO = 'colbymchenry/codegraph';
export const NPM_PACKAGE = '@colbymchenry/codegraph';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
export const INSTALL_SH_URL = `${RAW_BASE}/install.sh`;

// ---------------------------------------------------------------------------
// Install-method detection (pure — fully unit-testable via injected probes)
// ---------------------------------------------------------------------------

export type InstallMethod =
  | { kind: 'bundle'; os: 'unix' | 'windows'; bundleRoot: string; installDir: string | null }
  | { kind: 'npm'; scope: 'global' | 'local' }
  | { kind: 'npx' }
  | { kind: 'source'; root: string }
  | { kind: 'unknown'; reason: string };

export interface DetectInput {
  /** `__filename` of the running CLI module — `<…>/dist/bin/codegraph.js`. */
  filename: string;
  platform: NodeJS.Platform;
  cwd: string;
  /** Injectable existence probe (defaults to fs.existsSync) — for tests. */
  exists?: (p: string) => boolean;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Where the bundle installer keeps its install root, derived from the bundle
 * dir so an upgrade reuses a custom `CODEGRAPH_INSTALL_DIR`. Returns null when
 * the layout isn't the one the installer creates (then the installer falls
 * back to its own default).
 *
 *   unix:    <installDir>/versions/<vX.Y.Z>   (bundleRoot)  → <installDir>
 *   windows: <installDir>\current             (bundleRoot)  → <installDir>
 */
export function deriveInstallDir(
  bundleRoot: string,
  os: 'unix' | 'windows',
  exists: (p: string) => boolean
): string | null {
  // Use the TARGET platform's path semantics (not the host's), so this is
  // deterministic when reasoning about a Windows layout from a POSIX host (CI)
  // and vice-versa. In production `os` always matches the running platform.
  const P = os === 'windows' ? path.win32 : path.posix;
  if (os === 'windows') {
    if (P.basename(bundleRoot).toLowerCase() === 'current') {
      return P.dirname(bundleRoot);
    }
    return null;
  }
  // unix: bundleRoot is <installDir>/versions/<version>
  const parent = P.dirname(bundleRoot);
  if (P.basename(parent) === 'versions') {
    const installDir = P.dirname(parent);
    return exists(installDir) ? installDir : P.dirname(parent);
  }
  return null;
}

export function detectInstallMethod(input: DetectInput): InstallMethod {
  const exists = input.exists ?? fs.existsSync;
  const isWin = input.platform === 'win32';
  // Path math keyed on the TARGET platform so detection is host-independent
  // (a Windows layout resolves correctly even when unit-tested on macOS/Linux).
  const P = isWin ? path.win32 : path.posix;
  const binDir = P.dirname(input.filename); // <…>/bin

  // Bundle: <root>/lib/dist/bin/codegraph.js → <root> is up 3 from bin/.
  // A bundle has a vendored node + a launcher script as siblings of lib/.
  const bundleRoot = P.resolve(binDir, '..', '..', '..');
  const vendoredNode = P.join(bundleRoot, isWin ? 'node.exe' : 'node');
  const launcher = P.join(bundleRoot, 'bin', isWin ? 'codegraph.cmd' : 'codegraph');
  if (exists(vendoredNode) && exists(launcher)) {
    const os = isWin ? 'windows' : 'unix';
    return { kind: 'bundle', os, bundleRoot, installDir: deriveInstallDir(bundleRoot, os, exists) };
  }

  const norm = toPosix(input.filename);

  // npx cache: <…>/_npx/<hash>/node_modules/@colbymchenry/codegraph/…
  if (norm.includes('/_npx/')) {
    return { kind: 'npx' };
  }

  // npm install (global or local): lives under a node_modules tree.
  if (norm.includes('/node_modules/')) {
    const underCwd = norm.startsWith(toPosix(P.resolve(input.cwd)) + '/');
    return { kind: 'npm', scope: underCwd ? 'local' : 'global' };
  }

  // Source checkout: running <repo>/dist/bin/codegraph.js with a sibling .git.
  const repoRoot = P.resolve(binDir, '..', '..');
  if (exists(P.join(repoRoot, 'package.json')) && exists(P.join(repoRoot, '.git'))) {
    return { kind: 'source', root: repoRoot };
  }

  return { kind: 'unknown', reason: `unrecognized install layout at ${input.filename}` };
}

// ---------------------------------------------------------------------------
// Version helpers (pure)
// ---------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export function parseSemver(version: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) return null;
  return {
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: parseInt(m[3]!, 10),
    pre: m[4] ?? null,
  };
}

/** Returns >0 if a>b, <0 if a<b, 0 if equal. Throws on unparseable input. */
export function compareVersions(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (!sa || !sb) throw new Error(`cannot compare versions: "${a}" vs "${b}"`);
  if (sa.major !== sb.major) return sa.major - sb.major;
  if (sa.minor !== sb.minor) return sa.minor - sb.minor;
  if (sa.patch !== sb.patch) return sa.patch - sb.patch;
  // A prerelease is "less than" its release (1.0.0-rc < 1.0.0).
  if (sa.pre && !sb.pre) return -1;
  if (!sa.pre && sb.pre) return 1;
  if (sa.pre && sb.pre) return sa.pre < sb.pre ? -1 : sa.pre > sb.pre ? 1 : 0;
  return 0;
}

export function isUpdateAvailable(current: string, latest: string): boolean {
  try {
    return compareVersions(latest, current) > 0;
  } catch {
    // If either is unparseable (e.g. a dev "0.0.0-unknown"), treat differing
    // strings as "update available" so the user isn't stuck.
    return normalizeVersion(current) !== normalizeVersion(latest);
  }
}

/** `0.9.9` / `v0.9.9` → `v0.9.9` (release tags are v-prefixed). */
export function normalizeVersion(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t : `v${t}`;
}

/** Strip a leading `v`: `v0.9.9` → `0.9.9`. */
export function stripV(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t.slice(1) : t;
}

/**
 * Parse the release tag out of the `Location` header GitHub returns for
 * `/releases/latest` → `…/releases/tag/v0.9.9`. Pure so it's unit-tested.
 */
export function parseLatestTagFromLocation(location: string | undefined): string | null {
  if (!location) return null;
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location);
  return m ? decodeURIComponent(m[1]!) : null;
}

// ---------------------------------------------------------------------------
// Latest-version resolution (network)
// ---------------------------------------------------------------------------

function httpsGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
  });
}

/**
 * Resolve the latest release tag (e.g. `v0.9.9`).
 *
 * Primary: read the redirect `Location` from `github.com/<repo>/releases/latest`
 * — same trick install.sh uses, because the unauthenticated GitHub API is
 * rate-limited to 60 req/h/IP and 403s on shared/cloud hosts (issue #325). The
 * redirect has no such limit. Fall back to the API only if the redirect can't
 * be read.
 */
export async function resolveLatestVersion(repo = REPO, timeoutMs = 12000): Promise<string> {
  try {
    const res = await httpsGet(
      `https://github.com/${repo}/releases/latest`,
      { 'User-Agent': 'codegraph-upgrade' },
      timeoutMs
    );
    const loc = res.headers.location;
    const tag = parseLatestTagFromLocation(Array.isArray(loc) ? loc[0] : loc);
    if (tag) return normalizeVersion(tag);
  } catch {
    /* fall through to API */
  }
  try {
    const res = await httpsGet(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { 'User-Agent': 'codegraph-upgrade', Accept: 'application/vnd.github+json' },
      timeoutMs
    );
    const tag = JSON.parse(res.body)?.tag_name;
    if (typeof tag === 'string' && tag) return normalizeVersion(tag);
  } catch {
    /* fall through to error */
  }
  throw new Error(
    'could not resolve the latest version from GitHub. Check your network, or pin a version: `codegraph upgrade <version>`.'
  );
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  /** Pin a specific version (positional arg or CODEGRAPH_VERSION). */
  version?: string;
  /** Report current vs latest, don't change anything. */
  check?: boolean;
  /** Reinstall even if already on the resolved version. */
  force?: boolean;
}

/** Injectable side-effects so the orchestrator stays unit-testable. */
export interface UpgradeDeps {
  currentVersion: string;
  method: InstallMethod;
  resolveLatest: (pin?: string) => Promise<string>;
  /** Run a command inheriting stdio; returns its exit code (-1 = spawn failed). */
  run: (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => number;
  hasCommand: (cmd: string) => boolean;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  platform: NodeJS.Platform;
}

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** The honest, additive re-index reminder shown after a successful upgrade. */
export function reindexAdvisory(): string {
  return [
    c.dim('Your existing project indexes keep working, but were built by the previous version.'),
    c.dim('To pick up this version’s extraction improvements, refresh each project:'),
    `  ${c.cyan('codegraph sync')}        ${c.dim('# incremental, fast')}`,
    `  ${c.cyan('codegraph index -f')}    ${c.dim('# full rebuild')}`,
    c.dim('(`codegraph status` flags any index that predates the engine you’re running.)'),
  ].join('\n');
}

/**
 * Returns the process exit code (0 = success / nothing to do, 1 = failure).
 */
export async function runUpgrade(opts: UpgradeOptions, deps: UpgradeDeps): Promise<number> {
  const { currentVersion, method } = deps;

  // Resolve the target version (pinned or latest).
  let latest: string;
  try {
    latest = normalizeVersion(opts.version || (await deps.resolveLatest()));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const currentDisplay = normalizeVersion(currentVersion);
  deps.log(`${c.bold('CodeGraph')}  current ${c.cyan(currentDisplay)}  ${opts.version ? 'target' : 'latest'} ${c.cyan(latest)}`);

  const updateAvailable = isUpdateAvailable(currentVersion, latest);

  if (opts.check) {
    if (updateAvailable) {
      deps.log(c.yellow(`An update is available: ${currentDisplay} → ${latest}`));
      deps.log(c.dim('Run `codegraph upgrade` to install it.'));
    } else {
      deps.log(c.green(`You’re on the latest version (${currentDisplay}).`));
    }
    return 0;
  }

  if (!updateAvailable && !opts.force && !opts.version) {
    deps.log(c.green(`Already up to date (${currentDisplay}).`));
    deps.log(c.dim('Use `--force` to reinstall, or `codegraph upgrade <version>` to change versions.'));
    return 0;
  }

  // Dispatch by install method. bundle/npm perform a real binary update, so
  // after they succeed we self-heal the front-load hook (below); npx/source/
  // unknown don't update anything here, so they return directly.
  let code: number;
  switch (method.kind) {
    case 'bundle':
      code = await (method.os === 'windows'
        ? upgradeWindowsBundle(method, latest, deps)
        : upgradeUnixBundle(method, opts.version ? latest : undefined, deps));
      break;
    case 'npm':
      // npm version specs have no leading "v" (`@0.9.8`, not `@v0.9.8` — the
      // latter resolves as a nonexistent dist-tag).
      code = await upgradeNpm(method, opts.version ? stripV(latest) : 'latest', deps);
      break;
    case 'npx':
      deps.log(c.green('npx always runs the latest version on demand — nothing to upgrade.'));
      deps.log(c.dim(`Force a fresh fetch with: npx ${NPM_PACKAGE}@latest`));
      return 0;
    case 'source':
      deps.warn(`Running from a source checkout at ${method.root}.`);
      deps.log(c.dim('Upgrade it with: git pull && npm run build'));
      return 0;
    default:
      deps.error(`Couldn’t determine how CodeGraph was installed (${method.reason}).`);
      deps.log(c.dim(`Reinstall manually — see https://github.com/${REPO}#install`));
      return 1;
  }

  // After a successful update, ensure the front-load prompt hook is wired for an
  // already-configured global Claude install — so existing users pick it up on
  // upgrade, not only on a fresh `install` (the hook config is version-agnostic,
  // so the still-running old binary can write it safely). Idempotent + gated on
  // an existing Claude config, and skipped entirely by the kill-switch. Never
  // fatal to the upgrade.
  if (code === 0) {
    try {
      await selfHealPromptHook(deps);
    } catch {
      /* a hook-wiring hiccup must not fail the upgrade */
    }
  }
  return code;
}

/**
 * Wire the Claude `UserPromptSubmit` front-load hook on upgrade for an
 * already-configured global Claude install. No-op when Claude isn't configured,
 * when the hook is already present, or when the kill-switch is set.
 */
async function selfHealPromptHook(deps: UpgradeDeps): Promise<void> {
  if (process.env.CODEGRAPH_NO_PROMPT_HOOK === '1' || process.env.CODEGRAPH_PROMPT_HOOK === '0') return;
  const { claudeTarget, writePromptHookEntry } = await import('../installer/targets/claude');
  if (!claudeTarget.detect('global').alreadyConfigured) return;
  const res = writePromptHookEntry('global');
  if (res.action === 'created' || res.action === 'updated') {
    deps.log(
      c.dim('Enabled the CodeGraph front-load hook for Claude Code (structural prompts). Disable any time: CODEGRAPH_NO_PROMPT_HOOK=1'),
    );
  }
}

function upgradeUnixBundle(
  method: Extract<InstallMethod, { kind: 'bundle' }>,
  pinned: string | undefined,
  deps: UpgradeDeps
): number {
  const downloader = deps.hasCommand('curl')
    ? `curl -fsSL ${INSTALL_SH_URL}`
    : deps.hasCommand('wget')
      ? `wget -qO- ${INSTALL_SH_URL}`
      : null;
  if (!downloader) {
    deps.error('Neither curl nor wget is available to download the installer.');
    deps.log(c.dim(`Install curl, or run manually:  ${INSTALL_SH_URL} | sh`));
    return 1;
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (method.installDir) env.CODEGRAPH_INSTALL_DIR = method.installDir;
  if (pinned) env.CODEGRAPH_VERSION = pinned;

  deps.log(c.dim(`Running the installer (${downloader} | sh)…`));
  const code = deps.run('sh', ['-c', `${downloader} | sh`], env);
  if (code !== 0) {
    deps.error(`Installer exited with code ${code}.`);
    return 1;
  }
  deps.log('');
  deps.log(c.green('✓ Upgrade complete.') + c.dim(' Open a new terminal if the version looks unchanged (PATH cache).'));
  deps.log(reindexAdvisory());
  return 0;
}

/** Build the in-place Windows upgrade script (exported for unit-testing). */
export function buildWindowsUpgradeScript(bundleRoot: string, version: string, arch: string): string {
  const target = `win32-${arch}`;
  const url = `https://github.com/${REPO}/releases/download/${version}/codegraph-${target}.zip`;
  // Windows can't DELETE a running exe but CAN rename it, so we upgrade IN
  // PLACE: download → rename the locked node.exe aside → extract the new bundle
  // over current\. Synchronous, no detached helper (which dies under SSH/job
  // objects and has worse UX). The running process keeps its renamed node.exe
  // mapped; the NEXT `codegraph` invocation uses the new one. We can't reuse
  // install.ps1 here — it `Remove-Item`s current\, which fails on the locked exe.
  return [
    `$ErrorActionPreference='Stop'`,
    `$dest='${bundleRoot}'`,
    `$url='${url}'`,
    `Write-Host "Downloading $url"`,
    `$tmp=Join-Path $env:TEMP ('cg-up-'+[guid]::NewGuid().ToString('N'))`,
    `New-Item -ItemType Directory -Force -Path $tmp | Out-Null`,
    `$zip=Join-Path $tmp 'cg.zip'`,
    `Invoke-WebRequest -Uri $url -OutFile $zip`,
    `$stage=Join-Path $tmp 'stage'`,
    `Expand-Archive -Path $zip -DestinationPath $stage -Force`,
    `$inner=Join-Path $stage 'codegraph-${target}'`,
    `$src=if(Test-Path $inner){$inner}else{$stage}`,
    `$node=Join-Path $dest 'node.exe'`,
    `if(Test-Path $node){Rename-Item -Path $node -NewName ('node.exe.old-'+[guid]::NewGuid().ToString('N')) -Force}`,
    `Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force`,
    `Get-ChildItem -Path $dest -Filter 'node.exe.old-*' -ErrorAction SilentlyContinue | ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {} }`,
    `Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue`,
    `Write-Host "Installed CodeGraph ${version} to $dest"`,
  ].join(';');
}

function upgradeWindowsBundle(
  method: Extract<InstallMethod, { kind: 'bundle' }>,
  latest: string,
  deps: UpgradeDeps
): number {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const script = buildWindowsUpgradeScript(method.bundleRoot, latest, arch);
  // -EncodedCommand (base64 UTF-16LE), NOT -Command: Node's Windows argv→command
  // -line quoting mangles a long multi-statement script, so PowerShell never
  // parses it. Encoding sidesteps all shell quoting — the canonical approach.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  deps.log(c.dim(`Downloading and installing ${latest}…`));
  const code = deps.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  if (code !== 0) {
    deps.error(`Installer exited with code ${code}.`);
    return 1;
  }
  deps.log('');
  deps.log(c.green('✓ Upgrade complete.') + c.dim(' Open a new terminal to be safe (PATH/version cache).'));
  deps.log(reindexAdvisory());
  return 0;
}

function upgradeNpm(
  method: Extract<InstallMethod, { kind: 'npm' }>,
  versionSpec: string,
  deps: UpgradeDeps
): number {
  const npm = deps.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = method.scope === 'global'
    ? ['install', '-g', `${NPM_PACKAGE}@${versionSpec}`]
    : ['install', `${NPM_PACKAGE}@${versionSpec}`];
  deps.log(c.dim(`Running: ${npm} ${args.join(' ')}`));
  const code = deps.run(npm, args, process.env);
  if (code !== 0) {
    deps.error(`npm exited with code ${code}.`);
    if (method.scope === 'global') {
      deps.log(c.dim('If this is a permissions error (EACCES), your global prefix needs sudo, or use a'));
      deps.log(c.dim('Node version manager (nvm/fnm) so global installs don’t require root.'));
    }
    return 1;
  }
  deps.log('');
  deps.log(c.green('✓ Upgrade complete.'));
  deps.log(reindexAdvisory());
  return 0;
}

// ---------------------------------------------------------------------------
// Production deps wiring (used by the CLI)
// ---------------------------------------------------------------------------

/**
 * True if `cmd` resolves to an executable on PATH. A pure-Node PATH scan — NOT
 * a spawned `command -v`/`which`: `command` is a shell builtin (no standalone
 * binary on Debian, though macOS ships one), and `which` isn't guaranteed
 * present on minimal images, so spawning either is unreliable. Scanning PATH
 * ourselves behaves identically on every platform.
 */
export function hasCommand(cmd: string): boolean {
  const isWin = process.platform === 'win32';
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (isWin) return true;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        /* not here / not executable — keep scanning */
      }
    }
  }
  return false;
}

export function defaultRun(cmd: string, args: string[], env?: NodeJS.ProcessEnv): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: env ?? process.env, windowsHide: true });
  if (r.error) return -1;
  return r.status ?? -1;
}
