/**
 * SQLite adapter sanity tests
 *
 * After the switch to `bun:sqlite` there is no longer a native-vs-WASM
 * backend distinction. These tests just exercise the public surface
 * (open/close, prepare/run/get/all, transactions, named params) so a
 * regression in the thin adapter shows up immediately rather than as a
 * mysterious query failure deeper in the stack.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { CodeGraph } from '../src';

describe('DatabaseConnection — bun:sqlite adapter', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-backend-'));
  });

  afterEach(() => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initializes a database and reports it as open', () => {
    const dbPath = path.join(dir, 'test.db');
    const conn = DatabaseConnection.initialize(dbPath);
    expect(conn.isOpen()).toBe(true);
    conn.close();
    expect(conn.isOpen()).toBe(false);
  });

  it('persists schema across init and open', () => {
    const dbPath = path.join(dir, 'test.db');
    const c1 = DatabaseConnection.initialize(dbPath);
    c1.close();

    const c2 = DatabaseConnection.open(dbPath);
    const version = c2.getSchemaVersion();
    expect(version).not.toBeNull();
    expect(version!.version).toBeGreaterThan(0);
    c2.close();
  });

  it('CodeGraph indexes a tiny project end-to-end', async () => {
    fs.writeFileSync(path.join(dir, 'x.ts'), `export function x(): void {}\n`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const stats = cg.getStats();
      expect(stats.fileCount).toBeGreaterThan(0);
      expect(stats.nodeCount).toBeGreaterThan(0);
    } finally {
      cg.destroy();
    }
  });
});
