/**
 * Foundation Tests
 *
 * Tests for the CodeGraph foundation layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { DEFAULT_CONFIG, Node, Edge } from '../src/types';
import { loadConfig, saveConfig } from '../src/config';
import { isInitialized, getCodeGraphDir, validateDirectory } from '../src/directory';
import { DatabaseConnection, getDatabasePath } from '../src/db';

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('CodeGraph Foundation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('Initialization', () => {
    it('should initialize a new project', () => {
      const cg = CodeGraph.initSync(tempDir);

      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(true);
      expect(fs.existsSync(getDatabasePath(tempDir))).toBe(true);

      cg.close();
    });

    it('should create .gitignore in .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      const gitignorePath = path.join(getCodeGraphDir(tempDir), '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('*.db');

      cg.close();
    });

    it('should create config.json with defaults', () => {
      const cg = CodeGraph.initSync(tempDir);

      const configPath = path.join(getCodeGraphDir(tempDir), 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = cg.getConfig();
      expect(config.version).toBe(DEFAULT_CONFIG.version);
      expect(config.include).toEqual(DEFAULT_CONFIG.include);
      expect(config.exclude).toEqual(DEFAULT_CONFIG.exclude);

      cg.close();
    });

    it('should throw if already initialized', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      expect(() => CodeGraph.initSync(tempDir)).toThrow(/already initialized/i);
    });

    it('should accept custom config options', () => {
      const cg = CodeGraph.initSync(tempDir, {
        config: {
          maxFileSize: 500000,
          extractDocstrings: false,
        },
      });

      const config = cg.getConfig();
      expect(config.maxFileSize).toBe(500000);
      expect(config.extractDocstrings).toBe(false);

      cg.close();
    });
  });

  describe('Opening Projects', () => {
    it('should open an existing project', () => {
      // First initialize
      const cg1 = CodeGraph.initSync(tempDir);
      cg1.close();

      // Then open
      const cg2 = CodeGraph.openSync(tempDir);
      expect(cg2.getProjectRoot()).toBe(path.resolve(tempDir));
      cg2.close();
    });

    it('should throw if not initialized', () => {
      expect(() => CodeGraph.openSync(tempDir)).toThrow(/not initialized/i);
    });

    it('should preserve configuration across open/close', () => {
      const cg1 = CodeGraph.initSync(tempDir, {
        config: { maxFileSize: 123456 },
      });
      cg1.close();

      const cg2 = CodeGraph.openSync(tempDir);
      expect(cg2.getConfig().maxFileSize).toBe(123456);
      cg2.close();
    });
  });

  describe('Static Methods', () => {
    it('isInitialized should return false for new directory', () => {
      expect(CodeGraph.isInitialized(tempDir)).toBe(false);
    });

    it('isInitialized should return true after init', () => {
      const cg = CodeGraph.initSync(tempDir);
      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
      cg.close();
    });
  });

  describe('Database', () => {
    it('should create database with correct schema', () => {
      const cg = CodeGraph.initSync(tempDir);

      // Check that we can get stats (requires tables to exist)
      const stats = cg.getStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.fileCount).toBe(0);

      cg.close();
    });

    it('should return correct database size', () => {
      const cg = CodeGraph.initSync(tempDir);
      const stats = cg.getStats();

      // Database should have some size (at least the schema)
      expect(stats.dbSizeBytes).toBeGreaterThan(0);

      cg.close();
    });

    it('should support optimize operation', () => {
      const cg = CodeGraph.initSync(tempDir);

      // Should not throw
      expect(() => cg.optimize()).not.toThrow();

      cg.close();
    });

    it('should support clear operation', () => {
      const cg = CodeGraph.initSync(tempDir);

      // Should not throw
      expect(() => cg.clear()).not.toThrow();

      const stats = cg.getStats();
      expect(stats.nodeCount).toBe(0);

      cg.close();
    });
  });

  describe('Configuration', () => {
    it('should load and merge config with defaults', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const config = loadConfig(tempDir);
      expect(config.version).toBe(DEFAULT_CONFIG.version);
      expect(config.rootDir).toBe(path.resolve(tempDir));
    });

    it('should update configuration', () => {
      const cg = CodeGraph.initSync(tempDir);

      cg.updateConfig({ maxFileSize: 999999 });

      expect(cg.getConfig().maxFileSize).toBe(999999);

      cg.close();

      // Verify persistence
      const config = loadConfig(tempDir);
      expect(config.maxFileSize).toBe(999999);
    });
  });

  describe('Directory Management', () => {
    it('should validate directory structure', () => {
      const cg = CodeGraph.initSync(tempDir);
      cg.close();

      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should detect invalid directory', () => {
      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Uninitialize', () => {
    it('should remove .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      cg.uninitialize();

      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(false);
      expect(CodeGraph.isInitialized(tempDir)).toBe(false);
    });
  });

  describe('Close/Destroy', () => {
    it('should close database but keep .CodeGraph directory', () => {
      const cg = CodeGraph.initSync(tempDir);

      cg.destroy(); // destroy is alias for close

      expect(fs.existsSync(getCodeGraphDir(tempDir))).toBe(true);
      expect(CodeGraph.isInitialized(tempDir)).toBe(true);
    });
  });

  describe('Graph Query Methods', () => {
    it('should throw "Node not found" for non-existent nodes', () => {
      const cg = CodeGraph.initSync(tempDir);

      // getContext throws for non-existent nodes
      expect(() => cg.getContext('non-existent')).toThrow(/not found/i);

      cg.close();
    });

    it('should return empty results for non-existent nodes', () => {
      const cg = CodeGraph.initSync(tempDir);

      // These methods return empty results instead of throwing
      const traverseResult = cg.traverse('non-existent');
      expect(traverseResult.nodes.size).toBe(0);

      const callGraph = cg.getCallGraph('non-existent');
      expect(callGraph.nodes.size).toBe(0);

      const typeHierarchy = cg.getTypeHierarchy('non-existent');
      expect(typeHierarchy.nodes.size).toBe(0);

      const usages = cg.findUsages('non-existent');
      expect(usages.length).toBe(0);

      cg.close();
    });

    it('should require embedding initialization for semantic search', async () => {
      const cg = CodeGraph.initSync(tempDir);

      // Semantic search requires embeddings to be initialized first
      await expect(cg.semanticSearch('test')).rejects.toThrow(/not initialized/i);
      await expect(cg.findSimilar('test')).rejects.toThrow(/not initialized/i);

      // Check embedding status
      expect(cg.isEmbeddingsInitialized()).toBe(false);

      cg.close();
    });
  });
});

describe('Database Connection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should initialize new database', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    expect(db.isOpen()).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    db.close();
  });

  it('should get schema version', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const version = db.getSchemaVersion();
    expect(version).not.toBeNull();
    expect(version?.version).toBe(2);

    db.close();
  });

  it('should support transactions', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const result = db.transaction(() => {
      return 42;
    });

    expect(result).toBe(42);

    db.close();
  });

  it('should throw when opening non-existent database', () => {
    const dbPath = path.join(tempDir, 'nonexistent.db');

    expect(() => DatabaseConnection.open(dbPath)).toThrow(/not found/i);
  });
});

describe('Query Builder', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tempDir = createTempDir();
    cg = CodeGraph.initSync(tempDir);
  });

  afterEach(() => {
    cg.close();
    cleanupTempDir(tempDir);
  });

  it('should return null for non-existent node', () => {
    const node = cg.getNode('nonexistent');
    expect(node).toBeNull();
  });

  it('should return empty array for nodes in non-existent file', () => {
    const nodes = cg.getNodesInFile('nonexistent.ts');
    expect(nodes).toEqual([]);
  });

  it('should return empty array for edges from non-existent node', () => {
    const edges = cg.getOutgoingEdges('nonexistent');
    expect(edges).toEqual([]);
  });

  it('should return null for non-existent file', () => {
    const file = cg.getFile('nonexistent.ts');
    expect(file).toBeNull();
  });

  it('should return empty array for files when none tracked', () => {
    const files = cg.getFiles();
    expect(files).toEqual([]);
  });
});
