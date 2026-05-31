/**
 * Tests for --data-dir / dataDir option (issues #304, #452)
 *
 * Verifies that CodeGraph data can be stored in a custom directory instead of
 * the default <projectRoot>/.codegraph/.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCodeGraphDir, isInitialized, CODEGRAPH_DIR } from '../src/directory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDirs(...dirs: string[]): void {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// getCodeGraphDir
// ---------------------------------------------------------------------------

describe('getCodeGraphDir', () => {
  it('returns default .codegraph path when no dataDir given', () => {
    const root = os.tmpdir();
    expect(getCodeGraphDir(root)).toBe(path.join(root, CODEGRAPH_DIR));
  });

  it('returns absolute dataDir as-is', () => {
    const root = os.tmpdir();
    const custom = path.join(os.tmpdir(), 'external-storage', 'cg');
    expect(getCodeGraphDir(root, custom)).toBe(custom);
  });

  it('resolves relative dataDir against projectRoot', () => {
    const root = os.tmpdir();
    expect(getCodeGraphDir(root, 'knowledge/codegraph')).toBe(
      path.join(root, 'knowledge/codegraph')
    );
  });

  it('treats empty string dataDir as no dataDir (uses default)', () => {
    const root = os.tmpdir();
    // Empty string is falsy — falls through to default
    expect(getCodeGraphDir(root, '')).toBe(path.join(root, CODEGRAPH_DIR));
  });
});

// ---------------------------------------------------------------------------
// isInitialized with custom dataDir
// ---------------------------------------------------------------------------

describe('isInitialized with dataDir', () => {
  let projectDir: string;
  let customDataDir: string;

  afterEach(() => cleanupDirs(projectDir, customDataDir));

  it('returns false when custom dataDir does not exist', () => {
    projectDir = makeTempDir('cg-test-proj-');
    customDataDir = path.join(os.tmpdir(), `cg-test-custom-${Date.now()}`);
    expect(isInitialized(projectDir, customDataDir)).toBe(false);
  });

  it('returns false when custom dataDir exists but has no codegraph.db', () => {
    projectDir = makeTempDir('cg-test-proj-');
    customDataDir = makeTempDir('cg-test-custom-');
    expect(isInitialized(projectDir, customDataDir)).toBe(false);
  });

  it('returns true when custom dataDir contains codegraph.db', () => {
    projectDir = makeTempDir('cg-test-proj-');
    customDataDir = makeTempDir('cg-test-custom-');
    fs.writeFileSync(path.join(customDataDir, 'codegraph.db'), '');
    expect(isInitialized(projectDir, customDataDir)).toBe(true);
  });

  it('does NOT find default .codegraph when a different dataDir is specified', () => {
    projectDir = makeTempDir('cg-test-proj-');
    // Seed default .codegraph with a db
    const defaultDir = path.join(projectDir, CODEGRAPH_DIR);
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(path.join(defaultDir, 'codegraph.db'), '');

    // With a custom (empty) dataDir, should NOT find the default one
    customDataDir = makeTempDir('cg-test-custom-');
    expect(isInitialized(projectDir, customDataDir)).toBe(false);
  });
});
