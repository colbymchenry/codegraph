import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalRootKey, findNearestCodeGraphRoot } from '../src/directory';

/**
 * Regression coverage for #1057: the MCP server keyed its open-DB connection
 * cache by the resolved-root PATH STRING, so two spellings of one physical repo
 * — a symlinked checkout, or a case-variant on a case-insensitive mount (NTFS,
 * WSL DrvFs `/mnt/c`) — each opened a SEPARATE SQLite connection to the same
 * `.codegraph/codegraph.db` and corrupted the index.
 *
 * `canonicalRootKey` keys on filesystem identity (dev:ino), which is identical
 * for every spelling, so the cache dedupes them onto one connection. The
 * symlink case below is the deterministic, filesystem-agnostic proxy for the
 * case-insensitive-mount scenario (both produce two path strings for one inode);
 * it fails against the pre-fix `findNearestCodeGraphRoot`, which returned the
 * un-canonicalized symlink path.
 */
describe('index root identity (#1057)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rootid-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeProject(name: string): string {
    const proj = path.join(tmp, name);
    fs.mkdirSync(path.join(proj, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.codegraph', 'codegraph.db'), 'x');
    return proj;
  }

  it('gives one identity key to a directory and a symlink that points at it', () => {
    const real = makeProject('proj');
    const link = path.join(tmp, 'projLink');
    fs.symlinkSync(real, link);

    // Two distinct path strings for one physical directory...
    expect(path.resolve(real)).not.toBe(path.resolve(link));
    // ...but ONE filesystem identity, so the connection cache dedupes them.
    expect(canonicalRootKey(link)).toBe(canonicalRootKey(real));
  });

  it('maps both spellings of a resolved root to one cache identity', () => {
    const real = makeProject('proj');
    const link = path.join(tmp, 'projLink');
    fs.symlinkSync(real, link);

    // findNearestCodeGraphRoot resolves each spelling to its own (cased) string,
    const fromReal = findNearestCodeGraphRoot(real);
    const fromLink = findNearestCodeGraphRoot(link);
    expect(fromReal).not.toBeNull();
    expect(fromLink).not.toBeNull();

    // ...but the connection cache keys on identity, so both converge — which is
    // what stops the second SQLite connection that pre-fix corrupted the index.
    expect(canonicalRootKey(fromLink!)).toBe(canonicalRootKey(fromReal!));
  });

  it('keeps distinct projects on distinct identity keys', () => {
    const a = makeProject('a');
    const b = makeProject('b');
    expect(canonicalRootKey(a)).not.toBe(canonicalRootKey(b));
  });

  it('falls back to a stable string key when the root cannot be stat-ed', () => {
    const gone = path.join(tmp, 'does-not-exist');
    // No throw, and deterministic for a given input.
    expect(canonicalRootKey(gone)).toBe(canonicalRootKey(gone));
  });
});
