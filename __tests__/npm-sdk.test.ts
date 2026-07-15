/**
 * Programmatic/embedded SDK entry (`scripts/npm-sdk.js`) tests (issue #354).
 *
 * The published main package is a thin shim: the CLI `bin` (npm-shim.js) execs
 * the bundled Node, while `main` (npm-sdk.js) lets embedded consumers
 * `require("@colbymchenry/codegraph")` on their OWN Node by re-exporting the
 * compiled library that ships inside the per-platform optionalDependency
 * (@colbymchenry/codegraph-<target>/lib/dist/index.js).
 *
 * These tests stand up a temp main-package dir with a fake platform package as a
 * resolvable sibling, then require the SDK in a child process — so resolution,
 * the self-heal cache fallback, and the missing-bundle error are exercised
 * hermetically with no real bundle, network, or registry.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SDK_SRC = path.join(__dirname, '..', 'scripts', 'npm-sdk.js');
const target = `${process.platform}-${process.arch}`;
const VERSION = '9.9.9-test';

function mkTmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-sdk-${label}-`));
}

// A temp node_modules with the main package (npm-sdk.js + package.json). The
// fake platform package, when present, is written as a resolvable sibling so the
// SDK's `require.resolve('@colbymchenry/codegraph-<target>/...')` walks to it.
function makeConsumer(): { root: string; mainPkg: string } {
  const root = mkTmp('consumer');
  const mainPkg = path.join(root, 'node_modules', '@colbymchenry', 'codegraph');
  fs.mkdirSync(mainPkg, { recursive: true });
  fs.copyFileSync(SDK_SRC, path.join(mainPkg, 'npm-sdk.js'));
  fs.writeFileSync(
    path.join(mainPkg, 'package.json'),
    JSON.stringify({ name: '@colbymchenry/codegraph', version: VERSION, main: 'npm-sdk.js' }) + '\n'
  );
  return { root, mainPkg };
}

// Write a fake compiled library that exports a sentinel, at the given lib/dist
// root (used both for the platform package and the self-heal cache bundle).
function writeFakeLib(libDistDir: string, sentinel: string): void {
  fs.mkdirSync(libDistDir, { recursive: true });
  fs.writeFileSync(
    path.join(libDistDir, 'index.js'),
    `module.exports = { SENTINEL: ${JSON.stringify(sentinel)}, CodeGraph: function CodeGraph() {} };\n`
  );
}

function installPlatformPackage(root: string, sentinel: string): void {
  const pkgRoot = path.join(root, 'node_modules', '@colbymchenry', `codegraph-${target}`);
  writeFakeLib(path.join(pkgRoot, 'lib', 'dist'), sentinel);
  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: `@colbymchenry/codegraph-${target}`, version: VERSION }) + '\n'
  );
}

// require() the SDK in a child process so each case gets a fresh module cache.
function requireSdk(mainPkg: string, env: Record<string, string> = {}) {
  const code =
    `try { const m = require(${JSON.stringify(path.join(mainPkg, 'npm-sdk.js'))});` +
    ` process.stdout.write(JSON.stringify({ sentinel: m.SENTINEL, cg: typeof m.CodeGraph })); }` +
    ` catch (e) { process.stderr.write(String(e && e.message || e)); process.exit(7); }`;
  const r = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('npm-sdk programmatic entry', () => {
  it('re-exports the installed platform bundle library', () => {
    const { root, mainPkg } = makeConsumer();
    installPlatformPackage(root, 'platform-lib');
    // Isolate from any real self-healed cache on this machine.
    const r = requireSdk(mainPkg, { CODEGRAPH_INSTALL_DIR: path.join(root, '.empty-cache') });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ sentinel: 'platform-lib', cg: 'function' });
  });

  it('falls back to a self-healed cache bundle when the optional dep is absent', () => {
    const { root, mainPkg } = makeConsumer(); // no platform package installed
    const cacheDir = path.join(root, 'cache');
    writeFakeLib(
      path.join(cacheDir, 'bundles', `${target}-${VERSION}`, 'lib', 'dist'),
      'cache-lib'
    );
    const r = requireSdk(mainPkg, { CODEGRAPH_INSTALL_DIR: cacheDir });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ sentinel: 'cache-lib', cg: 'function' });
  });

  it('throws an actionable error when no bundle is installed or cached', () => {
    const { root, mainPkg } = makeConsumer(); // no platform package, empty cache
    const r = requireSdk(mainPkg, { CODEGRAPH_INSTALL_DIR: path.join(root, '.empty-cache') });
    expect(r.status).toBe(7);
    expect(r.stderr).toContain(`@colbymchenry/codegraph-${target}`);
    expect(r.stderr).toContain('not installed');
    expect(r.stderr).toContain('registry.npmjs.org');
  });
});
