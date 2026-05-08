/**
 * SQLite backend visibility tests
 *
 * Pins the WASM-fallback banner content + the per-instance backend
 * tracking. Closes the visibility gap behind issue #138.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildWasmFallbackBanner,
  WASM_FALLBACK_FIX_RECIPE,
} from '../src/db/sqlite-adapter';
import { DatabaseConnection } from '../src/db';
import { CodeGraph } from '../src';

describe('buildWasmFallbackBanner — fix-recipe content', () => {
  it('includes the macOS / Linux / cross-platform fix commands', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).toContain('WASM SQLite fallback active');
    expect(banner).toContain('5-10x slower');
    expect(banner).toContain('xcode-select --install');
    expect(banner).toContain('apt install build-essential');
    expect(banner).toContain('npm rebuild better-sqlite3');
    expect(banner).toContain('npm install better-sqlite3 --save');
    expect(banner).toContain('codegraph status');
  });

  it('appends the native load error when one is provided', () => {
    const banner = buildWasmFallbackBanner(
      "Cannot find module 'better-sqlite3'"
    );
    expect(banner).toContain(
      "Native load error: Cannot find module 'better-sqlite3'"
    );
  });

  it('omits the load-error block when no error is supplied', () => {
    const banner = buildWasmFallbackBanner();
    expect(banner).not.toContain('Native load error:');
  });
});

describe('WASM_FALLBACK_FIX_RECIPE — single source of truth', () => {
  it('mentions the three recovery commands', () => {
    expect(WASM_FALLBACK_FIX_RECIPE).toContain('xcode-select --install');
    expect(WASM_FALLBACK_FIX_RECIPE).toContain('npm rebuild better-sqlite3');
    expect(WASM_FALLBACK_FIX_RECIPE).toContain(
      'npm install better-sqlite3 --save'
    );
  });
});

describe('DatabaseConnection — per-instance backend reporting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-backend-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a concrete backend (native or wasm) for an initialized DB', () => {
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const backend = conn.getBackend();
    expect(['native', 'wasm']).toContain(backend);
    conn.close();
  });

  it('CodeGraph.getBackend() delegates to the underlying DatabaseConnection', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      expect(['native', 'wasm']).toContain(cg.getBackend());
    } finally {
      cg.destroy();
    }
  });
});
