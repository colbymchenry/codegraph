/**
 * Installer Tests
 *
 * Tests for installer config-writer fixes:
 * - readJsonFile error handling
 *
 * (The CLAUDE.md instructions block is no longer written — see issue
 * #529. The marker-based install/uninstall self-heal is covered in
 * `installer-targets.test.ts`.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the exported functions from config-writer
import {
  writeMcpConfig,
} from '../src/installer/config-writer';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-installer-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Installer Config Writer', () => {
  let origCwd: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanupTempDir(tempDir);
  });

  describe('readJsonFile error handling', () => {
    it('should return empty object for non-existent file', () => {
      // writeMcpConfig reads .mcp.json - if it doesn't exist, it should create it
      writeMcpConfig('local');

      const mcpJson = path.join(tempDir, '.mcp.json');
      expect(fs.existsSync(mcpJson)).toBe(true);

      const content = JSON.parse(fs.readFileSync(mcpJson, 'utf-8'));
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.codegraph).toBeDefined();
    });

    it('should handle corrupted JSON by creating backup', () => {
      // Create a corrupted .mcp.json
      const mcpJson = path.join(tempDir, '.mcp.json');
      fs.writeFileSync(mcpJson, '{ this is not valid json !!!');

      // Suppress console.warn during test
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw - gracefully handles corruption
      writeMcpConfig('local');

      // Should have warned
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls[0][0];
      expect(warnMsg).toContain('Warning');

      // Backup should exist
      expect(fs.existsSync(mcpJson + '.backup')).toBe(true);
      // Original backup content should be the corrupted content
      const backup = fs.readFileSync(mcpJson + '.backup', 'utf-8');
      expect(backup).toContain('this is not valid json');

      // New file should be valid JSON with codegraph config
      const content = JSON.parse(fs.readFileSync(mcpJson, 'utf-8'));
      expect(content.mcpServers.codegraph).toBeDefined();

      warnSpy.mockRestore();
    });

    it('should preserve existing valid config when adding codegraph', () => {
      const mcpJson = path.join(tempDir, '.mcp.json');
      fs.writeFileSync(mcpJson, JSON.stringify({
        mcpServers: { other: { command: 'other-tool' } },
        customField: 'preserved',
      }, null, 2));

      writeMcpConfig('local');

      const content = JSON.parse(fs.readFileSync(mcpJson, 'utf-8'));
      expect(content.mcpServers.codegraph).toBeDefined();
      expect(content.mcpServers.other).toBeDefined();
      expect(content.customField).toBe('preserved');
    });
  });
});
