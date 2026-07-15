/**
 * Sync Module Tests
 *
 * Tests for sync functionality (incremental updates).
 * Note: Git hooks functionality has been removed in favor of codegraph's
 * Claude Code hooks integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';

describe('Sync Module', () => {
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

  describe('Git-based sync', () => {
    let testDir: string;
    let cg: CodeGraph;

    function git(...args: string[]) {
      execFileSync('git', args, { cwd: testDir, stdio: 'pipe' });
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-git-sync-'));

      // Initialize a git repo with an initial commit
      git('init');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');

      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      git('add', '-A');
      git('commit', '-m', 'initial');

      // Initialize CodeGraph and index
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

    it('should detect modified files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function hello() { return 'modified'; }`
      );

      const result = await cg.sync();

      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toContain('src/index.ts');
    });

    it('should detect new untracked files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'new.ts'),
        `export function newFunc() { return 42; }`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(1);
      expect(result.changedFilePaths).toContain('src/new.ts');

      // Verify the function was indexed
      const nodes = cg.searchNodes('newFunc');
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('should stop reporting untracked files once they are indexed (issue #206)', async () => {
      // Untracked files stay `??` in git status even after codegraph indexes
      // them. Change detection must compare them against the DB by hash, not
      // report every untracked file as "added" on every sync/status.
      fs.writeFileSync(
        path.join(testDir, 'src', 'new.ts'),
        `export function newFunc() { return 42; }`
      );

      // First sync indexes the untracked file.
      const first = await cg.sync();
      expect(first.filesAdded).toBe(1);

      // The file is still untracked in git, but now lives in the DB.
      expect(cg.searchNodes('newFunc').length).toBeGreaterThan(0);

      // status must not keep flagging it as a pending addition...
      const changes = cg.getChangedFiles();
      expect(changes.added).not.toContain('src/new.ts');
      expect(changes.modified).not.toContain('src/new.ts');

      // ...and a second sync must be a no-op for it.
      const second = await cg.sync();
      expect(second.filesAdded).toBe(0);
      expect(second.filesModified).toBe(0);
    });

    it('should re-index an untracked file when its contents change', async () => {
      const filePath = path.join(testDir, 'src', 'new.ts');
      fs.writeFileSync(filePath, `export function newFunc() { return 42; }`);
      await cg.sync();

      // Modify the still-untracked file.
      fs.writeFileSync(filePath, `export function renamedFunc() { return 7; }`);

      const changes = cg.getChangedFiles();
      expect(changes.modified).toContain('src/new.ts');

      const result = await cg.sync();
      expect(result.filesModified).toBe(1);
      expect(cg.searchNodes('renamedFunc').length).toBeGreaterThan(0);
      expect(cg.searchNodes('newFunc').length).toBe(0);
    });

    it('should detect deleted files via git', async () => {
      fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

      const result = await cg.sync();

      expect(result.filesRemoved).toBe(1);

      // Verify function is gone
      const nodes = cg.searchNodes('hello');
      expect(nodes.length).toBe(0);
    });

    it('should skip files with unsupported extensions', async () => {
      // A .txt file has no supported grammar, so sync must not index it.
      fs.writeFileSync(
        path.join(testDir, 'src', 'notes.txt'),
        `just some notes`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
    });

    it('should report no changes on clean working tree', async () => {
      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
      expect(result.filesRemoved).toBe(0);
      expect(result.changedFilePaths).toBeUndefined();
    });
  });

  // Incremental sync's git fast path used to consume `git status` output without
  // the ignore matcher the full index applies — so a committed dependency dir
  // (built-in default exclude) or a tracked file under a .gitignored dir would
  // leak into the index via `sync`, then vanish on the next `index --force`. The
  // git fast path must exclude exactly what the full scan does. (#766)
  describe('Incremental sync honors the ignore matcher (#766)', () => {
    let testDir: string;
    let cg: CodeGraph;

    function git(...args: string[]) {
      execFileSync('git', args, { cwd: testDir, stdio: 'pipe' });
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-766-'));

      git('init');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');

      // Real project source — must keep flowing through sync untouched.
      fs.mkdirSync(path.join(testDir, 'src'));
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      // A COMMITTED vendor/ dir: tracked in git, but a built-in default exclude
      // git knows nothing about. git status happily reports edits to it.
      fs.mkdirSync(path.join(testDir, 'vendor'));
      fs.writeFileSync(
        path.join(testDir, 'vendor', 'lib.ts'),
        `export function vendoredHelper() { return 1; }`
      );

      // A tracked file inside a .gitignored dir: gitignore is a no-op for files
      // already committed, so git status still reports modifications to it.
      fs.writeFileSync(path.join(testDir, '.gitignore'), 'generated/\n');
      fs.mkdirSync(path.join(testDir, 'generated'));
      fs.writeFileSync(
        path.join(testDir, 'generated', 'out.ts'),
        `export function generatedThing() { return 2; }`
      );

      git('add', '-A'); // .gitignore + src/ + vendor/ (generated/ is now ignored)
      git('add', '-f', 'generated/out.ts'); // force the ignored-but-tracked file in
      git('commit', '-m', 'initial');

      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('the full index excludes both (baseline the sync path must match)', () => {
      expect(cg.searchNodes('hello').length).toBeGreaterThan(0);
      expect(cg.searchNodes('vendoredHelper')).toHaveLength(0);
      expect(cg.searchNodes('generatedThing')).toHaveLength(0);
    });

    it('does not re-index a modified tracked file in a built-in excluded dir (vendor/)', () => {
      fs.writeFileSync(
        path.join(testDir, 'vendor', 'lib.ts'),
        `export function vendoredHelper() { return 999; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.modified).not.toContain('vendor/lib.ts');
      expect(changes.added).not.toContain('vendor/lib.ts');
    });

    it('does not re-index a modified tracked file in a .gitignored dir', () => {
      fs.writeFileSync(
        path.join(testDir, 'generated', 'out.ts'),
        `export function generatedThing() { return 999; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.modified).not.toContain('generated/out.ts');
      expect(changes.added).not.toContain('generated/out.ts');
    });

    it('does not index a new untracked file in an excluded dir', () => {
      // vendor/ isn't in .gitignore, so an untracked file there surfaces as `??`
      // in git status — it must still be filtered to match the full index.
      fs.writeFileSync(
        path.join(testDir, 'vendor', 'extra.ts'),
        `export function vendoredExtra() { return 3; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.added).not.toContain('vendor/extra.ts');
    });

    it('status (getChangedFiles) agrees with sync — no phantom pending changes', async () => {
      // The user-visible symptom today: `codegraph status` reads getChangedFiles
      // and reports a vendor edit as a pending change that `sync` (a filesystem
      // reconcile) then never indexes — so the count never clears. Both must now
      // agree that nothing happened.
      fs.writeFileSync(
        path.join(testDir, 'vendor', 'lib.ts'),
        `export function vendoredHelper() { return 999; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);

      const result = await cg.sync();
      expect(result.filesModified).toBe(0);
      expect(result.changedFilePaths ?? []).not.toContain('vendor/lib.ts');
      expect(cg.searchNodes('vendoredHelper')).toHaveLength(0);
    });

    it('still syncs a normal modified source file (no over-filtering)', () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function hello() { return 'changed'; }`
      );
      const changes = cg.getChangedFiles();
      expect(changes.modified).toContain('src/index.ts');
    });
  });

  // Incremental sync used to scope resolution to the CHANGED files' refs, and
  // a completed pass deleted every ref it failed to resolve — so when a changed
  // file introduced an export/symbol that would satisfy a previously-failed ref
  // in an UNCHANGED file, nothing ever revisited it: the cross-file edge stayed
  // missing (with status reporting a clean index) until a full re-index. Failed
  // refs are now parked as status='failed' and retried when a sync lands files
  // carrying a matching symbol name. (#1240)
  describe('Sync resolves refs satisfied by a new export in another file (#1240)', () => {
    let testDir: string;
    let cg: CodeGraph;

    function write(rel: string, content: string) {
      fs.writeFileSync(path.join(testDir, rel), content);
    }

    function callersOf(fnName: string, kind: string = 'function'): string[] {
      const results = cg.searchNodes(fnName);
      const def = results.map((r) => r.node).find((n) => n.kind === kind && n.name === fnName);
      if (!def) return [];
      return cg.getCallers(def.id).map((c) => c.node.name);
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1240-'));

      // a.ts references `greet`, which does not exist anywhere yet — the ref
      // fails resolution during the initial index.
      write('a.ts', `import { greet } from './b';\n\nexport function run(): number {\n  return greet();\n}\n`);
      write('b.ts', `export function other(): number {\n  return 1;\n}\n`);

      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('baseline: the unresolvable ref creates no edge and does not report as pending', () => {
      expect(callersOf('greet')).toHaveLength(0);
      // Failed refs are parked, not pending — status must keep reporting a
      // healthy index, or every repo with external-library imports would
      // permanently warn about an "interrupted run".
      expect(cg.getPendingReferenceCount()).toBe(0);
    });

    it('creates the cross-file calls edge from the UNCHANGED file after sync', async () => {
      write('b.ts', `export function greet(): number {\n  return 42;\n}\n`);

      const result = await cg.sync();
      expect(result.filesModified).toBe(1);

      // The ref lives in a.ts, which did NOT change — only the retry of the
      // parked failed ref can create this edge.
      expect(callersOf('greet')).toContain('run');
      expect(cg.getPendingReferenceCount()).toBe(0);
    });

    it('the synced graph matches a full re-index (the issue\'s exact complaint)', async () => {
      write('b.ts', `export function greet(): number {\n  return 42;\n}\n`);
      await cg.sync();
      const synced = cg.getStats();

      await cg.indexAll();
      const reindexed = cg.getStats();

      expect(synced.edgeCount).toBe(reindexed.edgeCount);
      expect(synced.nodeCount).toBe(reindexed.nodeCount);
    });

    it('a second sync is a no-op and does not duplicate edges', async () => {
      write('b.ts', `export function greet(): number {\n  return 42;\n}\n`);
      await cg.sync();
      const afterFirst = cg.getStats();

      const second = await cg.sync();
      expect(second.filesModified).toBe(0);
      expect(cg.getStats().edgeCount).toBe(afterFirst.edgeCount);
      expect(callersOf('greet')).toContain('run');
    });

    it('retries dotted method refs via the name tail when a class gains the method', async () => {
      // `h.greet()` is stored as reference_name 'h.greet'; the retry lookup
      // must match it through name_tail ('greet') when Helper gains greet.
      write('use.ts', `import { Helper } from './helper';\n\nexport function useHelper(): number {\n  const h = new Helper();\n  return h.greet();\n}\n`);
      write('helper.ts', `export class Helper {\n  other(): number {\n    return 1;\n  }\n}\n`);
      await cg.sync();
      expect(callersOf('greet', 'method')).toHaveLength(0);

      write('helper.ts', `export class Helper {\n  other(): number {\n    return 1;\n  }\n  greet(): number {\n    return 42;\n  }\n}\n`);
      const result = await cg.sync();
      expect(result.filesModified).toBe(1);

      expect(callersOf('greet', 'method')).toContain('useHelper');
    });
  });

  // The removal-side counterpart of #1240: when a re-index (or file deletion)
  // drops a symbol other files had resolved edges to, those edges cascade away
  // and the referencing files — which did not change — were never given a
  // chance to re-resolve, so they could not rebind to an alternative
  // definition the way a full re-index would. Resolution edges now carry their
  // originating reference (metadata.refName), and a dropped edge is
  // resurrected as that exact ref: re-resolved in the same sync, or parked as
  // failed until the symbol reappears.
  describe('Sync rebinds or parks refs when a resolved symbol is removed (#1240 removal case)', () => {
    let testDir: string;
    let cg: CodeGraph;

    function write(rel: string, content: string) {
      fs.writeFileSync(path.join(testDir, rel), content);
    }

    function greetDef(): { id: string; filePath: string } | undefined {
      const results = cg.searchNodes('greet');
      const def = results.map((r) => r.node).find((n) => n.kind === 'function' && n.name === 'greet');
      return def ? { id: def.id, filePath: def.filePath } : undefined;
    }

    function greetCallers(): string[] {
      const def = greetDef();
      return def ? cg.getCallers(def.id).map((c) => c.node.name) : [];
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1240-removal-'));

      // No import — cross-file name matching, so the caller can legitimately
      // rebind to a definition in ANY file, which is what a full re-index does.
      write('a.ts', `export function run(): number {\n  return greet();\n}\n`);
      write('b.ts', `export function greet(): number {\n  return 42;\n}\n`);

      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
      // Baseline: the call resolved into b.ts.
      expect(greetCallers()).toContain('run');
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('rebinds the unchanged caller when the symbol moves to another file', async () => {
      write('b.ts', `export function other(): number {\n  return 1;\n}\n`);
      write('d.ts', `export function greet(): number {\n  return 42;\n}\n`);

      await cg.sync();

      const def = greetDef();
      expect(def?.filePath).toBe('d.ts');
      expect(greetCallers()).toContain('run');
      // Parity with a full re-index — the issue's contract.
      const synced = cg.getStats();
      await cg.indexAll();
      expect(cg.getStats().edgeCount).toBe(synced.edgeCount);
    });

    it('drops the edge on removal and restores it when the symbol returns', async () => {
      write('b.ts', `export function other(): number {\n  return 1;\n}\n`);
      await cg.sync();

      // Removed with no alternative: the edge must be gone (not preserved
      // against a nonexistent symbol) and status must stay clean while the
      // ref waits parked.
      expect(greetDef()).toBeUndefined();
      expect(cg.getPendingReferenceCount()).toBe(0);

      write('b.ts', `export function other(): number {\n  return 1;\n}\nexport function greet(): number {\n  return 42;\n}\n`);
      await cg.sync();

      expect(greetCallers()).toContain('run');
    });

    it('handles whole-file deletion: parks the ref, then rebinds when the symbol reappears elsewhere', async () => {
      fs.unlinkSync(path.join(testDir, 'b.ts'));
      const removal = await cg.sync();
      expect(removal.filesRemoved).toBe(1);
      expect(greetDef()).toBeUndefined();
      expect(cg.getPendingReferenceCount()).toBe(0);

      write('d.ts', `export function greet(): number {\n  return 99;\n}\n`);
      await cg.sync();

      expect(greetDef()?.filePath).toBe('d.ts');
      expect(greetCallers()).toContain('run');
    });
  });

  describe('Cross-file module-attribute caller edges survive callee re-index (#899)', () => {
    let testDir: string;
    let cg: CodeGraph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-899-'));

      // pkg/mod.py — a module with two functions, both called from a separate
      // test file via `mod.<fn>(...)` (module-attribute access). This is the
      // exact shape from the RAGFlow production case in issue #899.
      fs.mkdirSync(path.join(testDir, 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(testDir, 'test'), { recursive: true });
      fs.writeFileSync(
        path.join(testDir, 'pkg', '__init__.py'),
        ``
      );
      fs.writeFileSync(
        path.join(testDir, 'pkg', 'mod.py'),
        [
          `def callee_one(value):`,
          `    """First callee — docstring above the second callee so edits here shift its line."""`,
          `    return value + 1`,
          ``,
          ``,
          `def callee_two(value):`,
          `    """Second callee, called from the test file via mod.callee_two(...)."""`,
          `    return value + 2`,
          ``,
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(testDir, 'test', 'test_callers.py'),
        [
          `from pkg import mod`,
          ``,
          ``,
          `def test_calls_callee_one():`,
          `    assert mod.callee_one(1) == 2`,
          ``,
          ``,
          `def test_calls_callee_two():`,
          `    assert mod.callee_two(1) == 3`,
          ``,
        ].join('\n')
      );

      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.py'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

    function callerCount(fnName: string): number {
      const results = cg.searchNodes(fnName);
      const def = results.map(r => r.node).find(n => n.kind === 'function' && n.name === fnName);
      if (!def) return -1;
      return cg.getCallers(def.id).length;
    }

    it('preserves incoming cross-file calls edges when the callee file is re-indexed', async () => {
      // Baseline: both callees have one cross-file caller each.
      expect(callerCount('callee_one')).toBe(1);
      expect(callerCount('callee_two')).toBe(1);

      // Docstring-only edit to callee_one — adds 1 line, shifting callee_two's
      // line number. A naive ID-based edge restore would drop callee_two's
      // incoming edge (its node id changed); the (kind, name) re-resolve
      // preserves it. A docstring-only edit also confirms zero-AST-change
      // re-indexes don't sever edges.
      fs.writeFileSync(
        path.join(testDir, 'pkg', 'mod.py'),
        [
          `def callee_one(value):`,
          `    """First callee — docstring above the second callee so edits here shift its line."""`,
          `    """Probe: extra docstring line to shift callee_two's start line by 1."""`,
          `    return value + 1`,
          ``,
          ``,
          `def callee_two(value):`,
          `    """Second callee, called from the test file via mod.callee_two(...)."""`,
          `    return value + 2`,
          ``,
        ].join('\n')
      );

      const result = await cg.sync();
      expect(result.filesModified).toBe(1);

      // Both incoming cross-file calls edges must survive the callee re-index.
      expect(callerCount('callee_one')).toBe(1);
      expect(callerCount('callee_two')).toBe(1);
    });

    it('drops incoming edges for a callee that was renamed during re-index', async () => {
      // Baseline.
      expect(callerCount('callee_one')).toBe(1);

      // Rename callee_one -> callee_one_renamed. The old edge's target
      // (kind=function, name=callee_one) no longer matches any re-indexed
      // node, so the edge is correctly dropped (not preserved against a
      // non-existent symbol).
      fs.writeFileSync(
        path.join(testDir, 'pkg', 'mod.py'),
        [
          `def callee_one_renamed(value):`,
          `    """Renamed callee — the old edge targeting callee_one must not be restored."""`,
          `    return value + 1`,
          ``,
          ``,
          `def callee_two(value):`,
          `    """Second callee, called from the test file via mod.callee_two(...)."""`,
          `    return value + 2`,
          ``,
        ].join('\n')
      );

      await cg.sync();

      // The renamed callee has no callers (the test still calls mod.callee_one,
      // which no longer exists). The old callee_one node is gone, so its
      // callerCount is -1 (definition not found); callee_one_renamed exists
      // but has no incoming edges (the test calls the old name).
      expect(callerCount('callee_one')).toBe(-1);
      expect(callerCount('callee_one_renamed')).toBe(0);
      // callee_two is untouched by the rename and its edge survives.
      expect(callerCount('callee_two')).toBe(1);
    });
  });
});
