/**
 * Sync Module Tests
 *
 * Tests for git hooks installation and sync functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { GitHooksManager } from '../src/sync/git-hooks';

describe('Sync Module', () => {
  describe('Git Hooks', () => {
    let testDir: string;
    let cg: CodeGraph;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-test-'));

      // Create a sample source file
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      // Initialize CodeGraph
      cg = CodeGraph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    describe('isGitRepository()', () => {
      it('should return false for non-git directory', () => {
        expect(cg.isGitRepository()).toBe(false);
      });

      it('should return true for git directory', () => {
        // Initialize git
        fs.mkdirSync(path.join(testDir, '.git'));

        expect(cg.isGitRepository()).toBe(true);
      });
    });

    describe('isGitHookInstalled()', () => {
      it('should return false when no hook is installed', () => {
        // Initialize git
        fs.mkdirSync(path.join(testDir, '.git'));

        expect(cg.isGitHookInstalled()).toBe(false);
      });

      it('should return false for non-codegraph hook', () => {
        // Initialize git with a custom hook
        const hooksDir = path.join(testDir, '.git', 'hooks');
        fs.mkdirSync(path.join(testDir, '.git'));
        fs.mkdirSync(hooksDir);
        fs.writeFileSync(
          path.join(hooksDir, 'post-commit'),
          '#!/bin/sh\necho "custom hook"'
        );

        expect(cg.isGitHookInstalled()).toBe(false);
      });

      it('should return true when codegraph hook is installed', () => {
        // Initialize git
        fs.mkdirSync(path.join(testDir, '.git'));

        // Install hook
        cg.installGitHooks();

        expect(cg.isGitHookInstalled()).toBe(true);
      });
    });

    describe('installGitHooks()', () => {
      it('should fail if not a git repository', () => {
        const result = cg.installGitHooks();

        expect(result.success).toBe(false);
        expect(result.message).toContain('Not a git repository');
      });

      it('should install hook in git repository', () => {
        // Initialize git
        fs.mkdirSync(path.join(testDir, '.git'));

        const result = cg.installGitHooks();

        expect(result.success).toBe(true);
        expect(result.message).toContain('installed');

        // Verify hook file exists
        const hookPath = path.join(testDir, '.git', 'hooks', 'post-commit');
        expect(fs.existsSync(hookPath)).toBe(true);

        // Verify hook content contains marker
        const content = fs.readFileSync(hookPath, 'utf-8');
        expect(content).toContain('CodeGraph auto-sync hook');
        expect(content).toContain('codegraph sync');
      });

      it('should create hooks directory if missing', () => {
        // Initialize git without hooks directory
        fs.mkdirSync(path.join(testDir, '.git'));

        const result = cg.installGitHooks();

        expect(result.success).toBe(true);
        expect(fs.existsSync(path.join(testDir, '.git', 'hooks'))).toBe(true);
      });

      it('should backup existing non-codegraph hook', () => {
        // Initialize git with a custom hook
        const hooksDir = path.join(testDir, '.git', 'hooks');
        fs.mkdirSync(path.join(testDir, '.git'));
        fs.mkdirSync(hooksDir);
        const customHookContent = '#!/bin/sh\necho "custom hook"';
        fs.writeFileSync(
          path.join(hooksDir, 'post-commit'),
          customHookContent
        );

        const result = cg.installGitHooks();

        expect(result.success).toBe(true);
        expect(result.previousHookBackedUp).toBe(true);

        // Verify backup exists
        const backupPath = path.join(hooksDir, 'post-commit.codegraph-backup');
        expect(fs.existsSync(backupPath)).toBe(true);
        expect(fs.readFileSync(backupPath, 'utf-8')).toBe(customHookContent);
      });

      it('should update existing codegraph hook without backup', () => {
        // Initialize git
        fs.mkdirSync(path.join(testDir, '.git'));

        // Install hook first time
        cg.installGitHooks();

        // Install again (update)
        const result = cg.installGitHooks();

        expect(result.success).toBe(true);
        expect(result.message).toContain('updated');
        expect(result.previousHookBackedUp).toBeUndefined();
      });

      it('should log sync errors to .codegraph/sync.log', () => {
        fs.mkdirSync(path.join(testDir, '.git'));
        cg.installGitHooks();

        const hookPath = path.join(testDir, '.git', 'hooks', 'post-commit');
        const content = fs.readFileSync(hookPath, 'utf-8');

        // Sync command should redirect stderr to sync.log
        expect(content).toContain('.codegraph/sync.log');
        // The actual sync commands should NOT send stderr to /dev/null
        expect(content).toContain('codegraph sync --quiet 2>>"$LOGFILE"');
      });

      it('should make hook executable', () => {
        // Initialize git
        fs.mkdirSync(path.join(testDir, '.git'));

        cg.installGitHooks();

        const hookPath = path.join(testDir, '.git', 'hooks', 'post-commit');
        const stats = fs.statSync(hookPath);

        // Check executable bit (at least for owner)
        expect(stats.mode & 0o100).toBeTruthy();
      });
    });

    describe('removeGitHooks()', () => {
      it('should succeed if no hook exists', () => {
        // Initialize git
        fs.mkdirSync(path.join(testDir, '.git'));

        const result = cg.removeGitHooks();

        expect(result.success).toBe(true);
        expect(result.message).toContain('No post-commit hook found');
      });

      it('should not remove non-codegraph hook', () => {
        // Initialize git with a custom hook
        const hooksDir = path.join(testDir, '.git', 'hooks');
        fs.mkdirSync(path.join(testDir, '.git'));
        fs.mkdirSync(hooksDir);
        fs.writeFileSync(
          path.join(hooksDir, 'post-commit'),
          '#!/bin/sh\necho "custom hook"'
        );

        const result = cg.removeGitHooks();

        expect(result.success).toBe(false);
        expect(result.message).toContain('not installed by CodeGraph');

        // Verify hook still exists
        expect(fs.existsSync(path.join(hooksDir, 'post-commit'))).toBe(true);
      });

      it('should remove codegraph hook', () => {
        // Initialize git
        fs.mkdirSync(path.join(testDir, '.git'));

        // Install then remove
        cg.installGitHooks();
        const result = cg.removeGitHooks();

        expect(result.success).toBe(true);
        expect(result.message).toContain('removed');

        // Verify hook is gone
        const hookPath = path.join(testDir, '.git', 'hooks', 'post-commit');
        expect(fs.existsSync(hookPath)).toBe(false);
      });

      it('should restore backup when removing', () => {
        // Initialize git with a custom hook
        const hooksDir = path.join(testDir, '.git', 'hooks');
        fs.mkdirSync(path.join(testDir, '.git'));
        fs.mkdirSync(hooksDir);
        const customHookContent = '#!/bin/sh\necho "custom hook"';
        fs.writeFileSync(
          path.join(hooksDir, 'post-commit'),
          customHookContent
        );

        // Install (backs up custom hook) then remove
        cg.installGitHooks();
        const result = cg.removeGitHooks();

        expect(result.success).toBe(true);
        expect(result.restoredFromBackup).toBe(true);

        // Verify original hook is restored
        const hookPath = path.join(hooksDir, 'post-commit');
        expect(fs.existsSync(hookPath)).toBe(true);
        expect(fs.readFileSync(hookPath, 'utf-8')).toBe(customHookContent);

        // Verify backup is gone
        const backupPath = path.join(hooksDir, 'post-commit.codegraph-backup');
        expect(fs.existsSync(backupPath)).toBe(false);
      });
    });
  });

  describe('Git Worktree Support', () => {
    let mainRepoDir: string;
    let worktreeDir: string;

    beforeEach(() => {
      // Create a simulated main repo
      mainRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-worktree-main-'));
      // Create a simulated worktree directory
      worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-worktree-wt-'));
    });

    afterEach(() => {
      if (fs.existsSync(mainRepoDir)) {
        fs.rmSync(mainRepoDir, { recursive: true, force: true });
      }
      if (fs.existsSync(worktreeDir)) {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
    });

    it('should resolve hooks dir from worktree .git file (absolute path)', () => {
      // Set up main repo .git directory with worktrees
      const mainGitDir = path.join(mainRepoDir, '.git');
      fs.mkdirSync(mainGitDir);
      fs.mkdirSync(path.join(mainGitDir, 'hooks'));
      fs.mkdirSync(path.join(mainGitDir, 'worktrees'), { recursive: true });
      fs.mkdirSync(path.join(mainGitDir, 'worktrees', 'feature-branch'));

      // Create a .git file in the worktree pointing to the worktree gitdir (absolute path)
      const worktreeGitDir = path.join(mainGitDir, 'worktrees', 'feature-branch');
      fs.writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${worktreeGitDir}\n`);

      const manager = new GitHooksManager(worktreeDir);

      // Should resolve to the main repo .git directory
      expect(manager.isGitRepository()).toBe(true);

      // Hooks dir should be in the main repo
      const hooksDir = manager.getHooksDir();
      expect(hooksDir).toBe(path.join(mainGitDir, 'hooks'));
    });

    it('should resolve hooks dir from worktree .git file (relative path)', () => {
      // Set up a structure where worktree is a subdirectory of main repo
      // This simulates: mainRepo/.git/worktrees/feature-branch and worktree at mainRepo/worktrees/feature-branch
      const mainGitDir = path.join(mainRepoDir, '.git');
      fs.mkdirSync(mainGitDir);
      fs.mkdirSync(path.join(mainGitDir, 'hooks'));
      fs.mkdirSync(path.join(mainGitDir, 'worktrees', 'feature-branch'), { recursive: true });

      // Create worktree dir inside main repo for relative path test
      const relativeWorktreeDir = path.join(mainRepoDir, 'worktrees', 'feature-branch');
      fs.mkdirSync(relativeWorktreeDir, { recursive: true });

      // Relative path from worktree to its gitdir
      const relativeGitDir = path.relative(relativeWorktreeDir, path.join(mainGitDir, 'worktrees', 'feature-branch'));
      fs.writeFileSync(path.join(relativeWorktreeDir, '.git'), `gitdir: ${relativeGitDir}\n`);

      const manager = new GitHooksManager(relativeWorktreeDir);

      expect(manager.isGitRepository()).toBe(true);
      expect(manager.getHooksDir()).toBe(path.join(mainGitDir, 'hooks'));
    });

    it('should handle regular .git directory (not a worktree)', () => {
      const gitDir = path.join(mainRepoDir, '.git');
      fs.mkdirSync(gitDir);
      fs.mkdirSync(path.join(gitDir, 'hooks'));

      const manager = new GitHooksManager(mainRepoDir);

      expect(manager.isGitRepository()).toBe(true);
      expect(manager.getHooksDir()).toBe(path.join(gitDir, 'hooks'));
    });

    it('should handle missing .git (not a repo)', () => {
      const manager = new GitHooksManager(worktreeDir);

      expect(manager.isGitRepository()).toBe(false);
    });

    it('should handle .git file with invalid content', () => {
      fs.writeFileSync(path.join(worktreeDir, '.git'), 'this is not a valid gitdir reference\n');

      const manager = new GitHooksManager(worktreeDir);

      // Should not crash - falls back gracefully
      expect(manager.isGitRepository()).toBe(false);
    });

    it('should install hooks in main repo from worktree', () => {
      // Set up main repo
      const mainGitDir = path.join(mainRepoDir, '.git');
      fs.mkdirSync(mainGitDir);
      fs.mkdirSync(path.join(mainGitDir, 'worktrees', 'feature-branch'), { recursive: true });

      // Create worktree .git file
      const worktreeGitDir = path.join(mainGitDir, 'worktrees', 'feature-branch');
      fs.writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${worktreeGitDir}\n`);

      const manager = new GitHooksManager(worktreeDir);
      const result = manager.installHook();

      expect(result.success).toBe(true);

      // Hook should be in the main repo's hooks dir
      const hookPath = path.join(mainGitDir, 'hooks', 'post-commit');
      expect(fs.existsSync(hookPath)).toBe(true);
      const content = fs.readFileSync(hookPath, 'utf-8');
      expect(content).toContain('CodeGraph auto-sync hook');
    });
  });

  describe('Sync Functionality', () => {
    let testDir: string;
    let cg: CodeGraph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-func-'));

      // Create initial source files
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      // Initialize and index
      cg = CodeGraph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    describe('getChangedFiles()', () => {
      it('should detect added files', () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toContain('src/new.ts');
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect modified files', () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function hello() { return 'modified'; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toContain('src/index.ts');
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect removed files', () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toContain('src/index.ts');
      });
    });

    describe('sync()', () => {
      it('should reindex added files', async () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const result = await cg.sync();

        expect(result.filesAdded).toBe(1);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('newFunc');
        expect(nodes.length).toBeGreaterThan(0);
      });

      it('should reindex modified files', async () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function goodbye() { return 'farewell'; }`
        );

        const result = await cg.sync();

        expect(result.filesModified).toBe(1);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('goodbye');
        expect(nodes.length).toBeGreaterThan(0);

        // Verify old function is gone
        const oldNodes = cg.searchNodes('hello');
        expect(oldNodes.length).toBe(0);
      });

      it('should remove nodes from deleted files', async () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const result = await cg.sync();

        expect(result.filesRemoved).toBe(1);

        // Verify function is gone
        const nodes = cg.searchNodes('hello');
        expect(nodes.length).toBe(0);
      });

      it('should report no changes when nothing changed', async () => {
        const result = await cg.sync();

        expect(result.filesAdded).toBe(0);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);
        expect(result.filesChecked).toBeGreaterThan(0);
      });
    });
  });
});
