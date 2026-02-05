/**
 * Installer Tests
 *
 * Tests for installer config-writer fixes:
 * - readJsonFile error handling
 * - writeClaudeMd section replacement
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the exported functions from config-writer
import {
  writeMcpConfig,
  writePermissions,
  writeClaudeMd,
  hasMcpConfig,
  hasPermissions,
  hasClaudeMdSection,
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
      // writeMcpConfig reads claude.json - if it doesn't exist, it should create it
      writeMcpConfig('local');

      const claudeJson = path.join(tempDir, '.claude.json');
      expect(fs.existsSync(claudeJson)).toBe(true);

      const content = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.codegraph).toBeDefined();
    });

    it('should handle corrupted JSON by creating backup', () => {
      // Create a corrupted claude.json
      const claudeJson = path.join(tempDir, '.claude.json');
      fs.writeFileSync(claudeJson, '{ this is not valid json !!!');

      // Suppress console.warn during test
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw - gracefully handles corruption
      writeMcpConfig('local');

      // Should have warned
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls[0][0];
      expect(warnMsg).toContain('Warning');

      // Backup should exist
      expect(fs.existsSync(claudeJson + '.backup')).toBe(true);
      // Original backup content should be the corrupted content
      const backup = fs.readFileSync(claudeJson + '.backup', 'utf-8');
      expect(backup).toContain('this is not valid json');

      // New file should be valid JSON with codegraph config
      const content = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
      expect(content.mcpServers.codegraph).toBeDefined();

      warnSpy.mockRestore();
    });

    it('should preserve existing valid config when adding codegraph', () => {
      const claudeJson = path.join(tempDir, '.claude.json');
      fs.writeFileSync(claudeJson, JSON.stringify({
        mcpServers: { other: { command: 'other-tool' } },
        customField: 'preserved',
      }, null, 2));

      writeMcpConfig('local');

      const content = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
      expect(content.mcpServers.codegraph).toBeDefined();
      expect(content.mcpServers.other).toBeDefined();
      expect(content.customField).toBe('preserved');
    });
  });

  describe('writeClaudeMd section replacement', () => {
    it('should create new CLAUDE.md with markers', () => {
      const result = writeClaudeMd('local');

      expect(result.created).toBe(true);
      const content = fs.readFileSync(path.join(tempDir, '.claude', 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('<!-- CODEGRAPH_START -->');
      expect(content).toContain('<!-- CODEGRAPH_END -->');
      expect(content).toContain('## CodeGraph');
    });

    it('should replace marked section on update', () => {
      // First write
      writeClaudeMd('local');

      // Modify file to add custom content before and after
      const claudeMdPath = path.join(tempDir, '.claude', 'CLAUDE.md');
      const original = fs.readFileSync(claudeMdPath, 'utf-8');
      const modified = '## My Custom Section\n\nCustom content\n\n' + original + '\n\n## Another Section\n\nMore content\n';
      fs.writeFileSync(claudeMdPath, modified);

      // Second write should replace only the marked section
      const result = writeClaudeMd('local');
      expect(result.updated).toBe(true);

      const final = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(final).toContain('## My Custom Section');
      expect(final).toContain('Custom content');
      expect(final).toContain('## Another Section');
      expect(final).toContain('More content');
      expect(final).toContain('## CodeGraph');
    });

    it('should use atomic writes (no temp files left behind)', () => {
      writeClaudeMd('local');

      const claudeDir = path.join(tempDir, '.claude');
      const files = fs.readdirSync(claudeDir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('should not overwrite content after unmarked section with ### subsections', () => {
      // Create a CLAUDE.md with an unmarked CodeGraph section that has ### subsections
      // followed by another ## section
      const claudeDir = path.join(tempDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, [
        '## Pre-existing Section',
        '',
        'Some content',
        '',
        '## CodeGraph',
        '',
        '### Subsection A',
        '',
        'Old codegraph content',
        '',
        '### Subsection B',
        '',
        'More old content',
        '',
        '## Important Section After',
        '',
        'This content must not be overwritten!',
        '',
      ].join('\n'));

      const result = writeClaudeMd('local');
      expect(result.updated).toBe(true);

      const final = fs.readFileSync(claudeMdPath, 'utf-8');
      // The section after CodeGraph must be preserved
      expect(final).toContain('## Important Section After');
      expect(final).toContain('This content must not be overwritten!');
      // Pre-existing section should also be preserved
      expect(final).toContain('## Pre-existing Section');
      // New CodeGraph content should be present with markers
      expect(final).toContain('<!-- CODEGRAPH_START -->');
      expect(final).toContain('<!-- CODEGRAPH_END -->');
    });

    it('should replace unmarked section without subsections', () => {
      const claudeDir = path.join(tempDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      // Note: regex needs \n before ## CodeGraph, so prefix with another section
      fs.writeFileSync(claudeMdPath, [
        '## Intro',
        '',
        'Preamble',
        '',
        '## CodeGraph',
        '',
        'Old simple content',
        '',
        '## Next Section',
        '',
        'Must be preserved',
        '',
      ].join('\n'));

      writeClaudeMd('local');

      const final = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(final).toContain('<!-- CODEGRAPH_START -->');
      expect(final).toContain('## Next Section');
      expect(final).toContain('Must be preserved');
      expect(final).not.toContain('Old simple content');
    });
  });
});
