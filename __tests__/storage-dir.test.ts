/**
 * Custom index storage directory (#986).
 *
 * `CodeGraph.init` / `CodeGraph.open` take a `storageDir` that holds the index
 * (`codegraph.db`, its WAL sidecars, the lock) instead of
 * `{projectRoot}/.codegraph/`. Source files are still scanned from the project,
 * query results still carry project-relative paths, and the project directory
 * is left untouched. Omitting `storageDir` keeps the old layout exactly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getCodeGraphDir, getCodeGraphStorageDir, isInitialized } from '../src/directory';
import { getDatabasePath } from '../src/db';

const PROJECT_FILES: Record<string, string> = {
  'src/user-service.ts': `export class UserService {
  private users = new Map<string, string>();

  findUser(id: string): string | undefined {
    return this.users.get(id);
  }
}
`,
  'src/main.ts': `import { UserService } from './user-service';

export function boot(): UserService {
  return new UserService();
}
`,
};

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeProject(root: string, files: Record<string, string> = PROJECT_FILES): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const dir = createTempDir(prefix);
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('storageDir (#986)', () => {
  it('puts the database in storageDir and creates no .codegraph in the project', async () => {
    const root = tempDir('codegraph-storage-project-');
    const storageDir = tempDir('codegraph-storage-data-');
    writeProject(root);

    const cg = await CodeGraph.init(root, { index: true, storageDir });

    expect(fs.existsSync(path.join(storageDir, 'codegraph.db'))).toBe(true);
    expect(getCodeGraphDir(root)).toBe(storageDir);
    expect(getDatabasePath(root)).toBe(path.join(storageDir, 'codegraph.db'));
    expect(isInitialized(root)).toBe(true);
    expect(CodeGraph.isInitialized(root)).toBe(true);
    expect(getCodeGraphStorageDir(root)).toBe(storageDir);

    // Nothing of the index was left in the project, not even the folder.
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
    expect(fs.readdirSync(root).sort()).toEqual(['src']);
    // An app-data directory outside the project gets no generated .gitignore.
    expect(fs.existsSync(path.join(storageDir, '.gitignore'))).toBe(false);

    cg.close();
  });

  it('keeps query results relative to the real project', async () => {
    const root = tempDir('codegraph-storage-project-');
    const storageDir = tempDir('codegraph-storage-data-');
    writeProject(root);

    const cg = await CodeGraph.init(root, { index: true, storageDir });

    const results = cg.searchNodes('UserService');
    expect(results.length).toBeGreaterThan(0);
    const declared = results.find((r) => r.node.name === 'UserService');
    expect(declared?.node.filePath).toBe('src/user-service.ts');
    for (const result of results) {
      expect(path.isAbsolute(result.node.filePath)).toBe(false);
      expect(result.node.filePath.startsWith(storageDir)).toBe(false);
    }

    expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['src/main.ts', 'src/user-service.ts']);

    cg.close();
  });

  it('opens an existing index from storageDir', async () => {
    const root = tempDir('codegraph-storage-project-');
    const storageDir = tempDir('codegraph-storage-data-');
    writeProject(root);

    const init = await CodeGraph.init(root, { index: true, storageDir });
    init.close();

    const cg = await CodeGraph.open(root, { storageDir });
    const results = cg.searchNodes('boot');
    expect(results.some((r) => r.node.filePath === 'src/main.ts')).toBe(true);
    expect(getDatabasePath(root)).toBe(path.join(storageDir, 'codegraph.db'));
    cg.close();
  });

  it('does not index an in-tree storageDir as project source', async () => {
    const root = tempDir('codegraph-storage-project-');
    writeProject(root);
    const storageDir = path.join(root, 'index-store');
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(storageDir, 'planted.ts'), 'export function plantedSymbol() { return 1; }\n');

    const cg = await CodeGraph.init(root, { index: true, storageDir });

    expect(fs.existsSync(path.join(storageDir, 'codegraph.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
    expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['src/main.ts', 'src/user-service.ts']);
    expect(cg.searchNodes('plantedSymbol')).toHaveLength(0);

    cg.close();
  });

  it('keeps the default .codegraph layout when storageDir is omitted', async () => {
    const root = tempDir('codegraph-storage-project-');
    writeProject(root);

    const cg = await CodeGraph.init(root, { index: true });

    expect(getCodeGraphStorageDir(root)).toBeNull();
    expect(getCodeGraphDir(root)).toBe(path.join(root, '.codegraph'));
    expect(fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.codegraph', '.gitignore'))).toBe(true);
    expect(cg.searchNodes('UserService').some((r) => r.node.filePath === 'src/user-service.ts')).toBe(true);

    cg.close();
  });

  it('opens at storageDir, not at a default .codegraph index', async () => {
    const root = tempDir('codegraph-storage-project-');
    const storageDir = tempDir('codegraph-storage-data-');
    writeProject(root);

    const cg = await CodeGraph.init(root, { index: false });
    cg.close();
    expect(fs.existsSync(path.join(root, '.codegraph', 'codegraph.db'))).toBe(true);

    await expect(CodeGraph.open(root, { storageDir })).rejects.toThrow(/not initialized/i);
  });

  it('rejects a storageDir at the project root itself or above it', () => {
    const root = tempDir('codegraph-storage-project-');

    expect(() => CodeGraph.initSync(root, { storageDir: root })).toThrow(/must not be the project root/i);
    expect(() => CodeGraph.initSync(root, { storageDir: path.dirname(root) })).toThrow(/ancestor/i);
    expect(fs.existsSync(path.join(root, '.codegraph'))).toBe(false);
  });
});
