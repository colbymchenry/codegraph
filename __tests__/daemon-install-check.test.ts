/**
 * A daemon whose install was upgraded or deleted underneath it exits (#2335).
 *
 * The daemon loads grammars (and the native kernel, and worker scripts) lazily
 * from the directory it was started from. An upgrade replaces or deletes that
 * directory while the daemon keeps running, so every later load fails; the
 * 1.6.1 daemon in #2335 went on re-indexing files as empty for as long as it
 * lived. It now checks its own package.json periodically and makes way for a
 * daemon started from the current install. The check is pure and the Daemon's
 * reaction is tested with it injected; neither starts a real daemon.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Daemon, installChangedReason } from '../src/mcp/daemon';

describe('installChangedReason', () => {
  let dir: string;
  let pkg: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-install-check-'));
    pkg = path.join(dir, 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({ name: '@colbymchenry/codegraph', version: '1.6.2' }));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is null while the install still carries the running version', () => {
    expect(installChangedReason(pkg, '1.6.2')).toBeNull();
  });

  it('reports an install upgraded in place', () => {
    fs.writeFileSync(pkg, JSON.stringify({ version: '1.6.3' }));
    expect(installChangedReason(pkg, '1.6.2')).toMatch(/replaced by v1\.6\.3/);
  });

  it('reports an install that was deleted, file or whole directory', () => {
    fs.rmSync(pkg);
    expect(installChangedReason(pkg, '1.6.2')).toMatch(/removed/);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(installChangedReason(pkg, '1.6.2')).toMatch(/removed/);
  });

  it('waits for a package.json caught mid-write instead of exiting on it', () => {
    fs.writeFileSync(pkg, '{"name": "@colbymchenry/codeg');
    expect(installChangedReason(pkg, '1.6.2')).toBeNull();
    fs.writeFileSync(pkg, '');
    expect(installChangedReason(pkg, '1.6.2')).toBeNull();
  });
});

describe('Daemon.checkInstall', () => {
  // A Daemon is safe to construct (nothing binds until start()); stop() is
  // replaced so a positive check can't tear down the test process.
  const makeDaemon = () => {
    const d = new Daemon('/tmp/codegraph-install-check-unit-test', { idleTimeoutMs: 0 }) as any;
    d.stop = vi.fn(async () => {});
    return d;
  };

  it('stops the daemon when its install changed', () => {
    const d = makeDaemon();
    expect(d.checkInstall(() => 'Install removed')).toBe(true);
    expect(d.stop).toHaveBeenCalledWith('install changed');
  });

  it('keeps running while the install is unchanged', () => {
    const d = makeDaemon();
    expect(d.checkInstall(() => null)).toBe(false);
    expect(d.stop).not.toHaveBeenCalled();
  });

  it('does nothing once the daemon is already stopping', () => {
    const d = makeDaemon();
    d.stopping = true;
    expect(d.checkInstall(() => 'Install removed')).toBe(false);
    expect(d.stop).not.toHaveBeenCalled();
  });
});
