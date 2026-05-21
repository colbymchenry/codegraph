
import { DatabaseConnection, getDatabasePath, DATABASE_FILENAME } from '../index';
import { createDatabase, SqliteDatabase, SqliteBackend } from '../sqlite-adapter';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs and path modules
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  statSync: jest.fn(),
}));

jest.mock('path', () => ({
  dirname: jest.fn(),
  join: jest.fn(),
}));

// Mock sqlite-adapter
jest.mock('../sqlite-adapter', () => ({
  createDatabase: jest.fn(),
  WASM_FALLBACK_FIX_RECIPE: 'test-recipe',
}));

// Mock migrations
jest.mock('../migrations', () => ({
  runMigrations: jest.fn(),
  getCurrentVersion: jest.fn(),
  CURRENT_SCHEMA_VERSION: 1,
}));

describe('DatabaseConnection', () => {
  let mockDb: SqliteDatabase;
  let mockBackend: SqliteBackend;

  beforeEach(() => {
    mockDb = {
      pragma: jest.fn(),
      exec: jest.fn(),
      prepare: jest.fn().mockReturnValue({ run: jest.fn(), get: jest.fn() }),
      transaction: jest.fn((fn) => () => fn()),
      close: jest.fn(),
      open: true,
    } as unknown as SqliteDatabase;

    mockBackend = {
      type: 'mock',
    } as SqliteBackend;

    (createDatabase as jest.Mock).mockReturnValue({ db: mockDb, backend: mockBackend });
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (path.dirname as jest.Mock).mockReturnValue('/tmp');
    (path.join as jest.Mock).mockReturnValue('/tmp/test.db');
    (fs.readFileSync as jest.Mock).mockReturnValue('SQL SCHEMA');
    (fs.statSync as jest.Mock).mockReturnValue({ size: 1024 });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize a new database and set busy_timeout', () => {
      const dbPath = '/tmp/test.db';
      const conn = DatabaseConnection.initialize(dbPath);

      expect(fs.existsSync).toHaveBeenCalledWith('/tmp');
      expect(fs.mkdirSync).not.toHaveBeenCalled(); // Directory exists
      expect(createDatabase).toHaveBeenCalledWith(dbPath);
      expect(mockDb.pragma).toHaveBeenCalledWith('foreign_keys = ON');
      expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
      expect(mockDb.pragma).toHaveBeenCalledWith('busy_timeout = 300000');
      expect(mockDb.exec).toHaveBeenCalledWith('SQL SCHEMA');
      expect(conn).toBeInstanceOf(DatabaseConnection);
    });

    it('should create directory if it does not exist', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const dbPath = '/tmp/test.db';
      DatabaseConnection.initialize(dbPath);
      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp', { recursive: true });
    });
  });

  describe('open', () => {
    it('should open an existing database and set busy_timeout', () => {
      const dbPath = '/tmp/test.db';
      const conn = DatabaseConnection.open(dbPath);

      expect(fs.existsSync).toHaveBeenCalledWith(dbPath);
      expect(createDatabase).toHaveBeenCalledWith(dbPath);
      expect(mockDb.pragma).toHaveBeenCalledWith('foreign_keys = ON');
      expect(mockDb.pragma).toHaveBeenCalledWith('journal_mode = WAL');
      expect(mockDb.pragma).toHaveBeenCalledWith('busy_timeout = 300000');
      expect(conn).toBeInstanceOf(DatabaseConnection);
    });

    it('should throw error if database not found', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const dbPath = '/tmp/nonexistent.db';
      expect(() => DatabaseConnection.open(dbPath)).toThrowError(`Database not found: ${dbPath}`);
    });
  });

  describe('getDb', () => {
    it('should return the underlying database instance', () => {
      const conn = DatabaseConnection.initialize('/tmp/test.db');
      expect(conn.getDb()).toBe(mockDb);
    });
  });

  describe('getBackend', () => {
    it('should return the backend instance', () => {
      const conn = DatabaseConnection.initialize('/tmp/test.db');
      expect(conn.getBackend()).toBe(mockBackend);
    });
  });

  describe('getPath', () => {
    it('should return the database path', () => {
      const dbPath = '/tmp/test.db';
      const conn = DatabaseConnection.initialize(dbPath);
      expect(conn.getPath()).toBe(dbPath);
    });
  });

  describe('transaction', () => {
    it('should execute a function within a transaction', () => {
      const conn = DatabaseConnection.initialize('/tmp/test.db');
      const mockFn = jest.fn(() => 'result');
      const result = conn.transaction(mockFn);
      expect(mockDb.transaction).toHaveBeenCalledWith(mockFn);
      expect(result).toBe('result');
    });
  });

  describe('getSize', () => {
    it('should return the database file size', () => {
      const conn = DatabaseConnection.initialize('/tmp/test.db');
      expect(conn.getSize()).toBe(1024);
      expect(fs.statSync).toHaveBeenCalledWith('/tmp/test.db');
    });
  });

  describe('optimize', () => {
    it('should execute VACUUM and ANALYZE', () => {
      const conn = DatabaseConnection.initialize('/tmp/test.db');
      conn.optimize();
      expect(mockDb.exec).toHaveBeenCalledWith('VACUUM');
      expect(mockDb.exec).toHaveBeenCalledWith('ANALYZE');
    });
  });

  describe('close', () => {
    it('should close the database connection', () => {
      const conn = DatabaseConnection.initialize('/tmp/test.db');
      conn.close();
      expect(mockDb.close).toHaveBeenCalled();
    });
  });

  describe('isOpen', () => {
    it('should return true if database is open', () => {
      const conn = DatabaseConnection.initialize('/tmp/test.db');
      expect(conn.isOpen()).toBe(true);
    });

    it('should return false if database is closed', () => {
      mockDb.open = false;
      const conn = DatabaseConnection.initialize('/tmp/test.db');
      expect(conn.isOpen()).toBe(false);
    });
  });

  describe('getDatabasePath', () => {
    it('should return the correct database path', () => {
      (path.join as jest.Mock).mockReturnValue('/project/root/.codegraph/codegraph.db');
      const projectRoot = '/project/root';
      const result = getDatabasePath(projectRoot);
      expect(path.join).toHaveBeenCalledWith(projectRoot, '.codegraph', DATABASE_FILENAME);
      expect(result).toBe('/project/root/.codegraph/codegraph.db');
    });
  });
});
