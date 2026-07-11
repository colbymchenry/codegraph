/**
 * Orphaned unresolved-refs sweep (#1187)
 *
 * A resolution pass that dies mid-run (watchdog SIGKILL, Ctrl-C, crash)
 * leaves the refs it never reached in unresolved_refs. The git-scoped sync
 * fast path only ever reads the changed files' rows, so those orphans — and
 * the call edges they represent — used to be missing permanently until a
 * full re-index. Field report: a Spring monorepo where blast radius showed
 * 3 of 10 caller files for a method behind @Resource field injection.
 *
 * These tests pin the healing behavior: a completed pass consumes every row
 * it processes (resolved or not), and sync sweeps any leftovers even when
 * no files changed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('Orphaned refs sweep (#1187)', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-orphan-sweep-'));
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  /** Distinct files with a `calls` edge into the node. */
  function callerFiles(target: { id: string }): string[] {
    return [...new Set(cg.getCallers(target.id).map((c) => c.node.filePath))].sort();
  }

  /**
   * Leave `relPath` in the exact on-disk state a resolution pass killed
   * mid-run leaves behind: content re-extracted (nodes + refs re-inserted,
   * old edges cascade-deleted, content hash stamped current) but resolution
   * never run. The content tweak is needed because re-extraction of
   * byte-identical content is a no-op; the hash stamp means a later sync
   * sees NO changed files.
   */
  async function interruptAfterExtraction(relPath: string): Promise<void> {
    fs.appendFileSync(path.join(testDir, relPath), '\n// interrupted-run edit\n');
    await cg.indexFiles([relPath]);
  }

  function findMethod(name: string) {
    const hit = cg
      .searchNodes(name)
      .find((r) => (r.node.kind === 'method' || r.node.kind === 'function') && r.node.name === name);
    expect(hit, `expected an indexed definition of ${name}`).toBeDefined();
    return hit!.node;
  }

  describe('sync() heals an interrupted resolution run', () => {
    beforeEach(async () => {
      // The #1187 shape: a concrete @Component class called through Spring
      // @Resource field injection from another package.
      const supportDir = path.join(testDir, 'src', 'support');
      const notifyDir = path.join(testDir, 'src', 'notify');
      fs.mkdirSync(supportDir, { recursive: true });
      fs.mkdirSync(notifyDir, { recursive: true });

      fs.writeFileSync(
        path.join(supportDir, 'MemberDescriptionSupport.java'),
        [
          'package com.demo.support;',
          '',
          'public class MemberDescriptionSupport {',
          '    public String getSuperVipName() {',
          '        return "SVIP";',
          '    }',
          '}',
          '',
        ].join('\n')
      );

      fs.writeFileSync(
        path.join(notifyDir, 'NotifyBuilder.java'),
        [
          'package com.demo.notify;',
          '',
          'import com.demo.support.MemberDescriptionSupport;',
          '',
          'public class NotifyBuilder {',
          '    private MemberDescriptionSupport memberDescriptionSupport;',
          '',
          '    public String buildParams() {',
          '        return memberDescriptionSupport.getSuperVipName();',
          '    }',
          '}',
          '',
        ].join('\n')
      );

      cg = CodeGraph.initSync(testDir);
      await cg.indexAll();
    });

    it('resolves leftover refs on a sync with NO file changes', async () => {
      const target = findMethod('getSuperVipName');

      // Healthy baseline: the caller edge exists, no refs pending.
      expect(callerFiles(target)).toContain('src/notify/NotifyBuilder.java');
      expect(cg.getPendingReferenceCount()).toBe(0);

      // Simulate the interrupted run: re-extract the caller (cascade-deleting
      // its old nodes and edges, re-inserting its refs) and stop before
      // resolution — exactly the state a killed "Resolving refs" phase
      // leaves behind.
      await interruptAfterExtraction('src/notify/NotifyBuilder.java');
      expect(cg.getPendingReferenceCount()).toBeGreaterThan(0);
      expect(callerFiles(target)).not.toContain('src/notify/NotifyBuilder.java');

      // The file on disk is unchanged, so this sync re-extracts nothing —
      // pre-fix it returned without touching resolution and the edge stayed
      // missing forever.
      const result = await cg.sync();
      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);

      expect(cg.getPendingReferenceCount()).toBe(0);
      expect(callerFiles(target)).toContain('src/notify/NotifyBuilder.java');
    });

    it('is idempotent: a second no-change sync stays clean', async () => {
      await interruptAfterExtraction('src/notify/NotifyBuilder.java');
      await cg.sync();
      const target = findMethod('getSuperVipName');
      const healed = callerFiles(target);

      const again = await cg.sync();
      expect(again.filesAdded + again.filesModified + again.filesRemoved).toBe(0);
      expect(cg.getPendingReferenceCount()).toBe(0);
      expect(callerFiles(target)).toEqual(healed);
    });
  });

  describe('completed passes consume every processed row', () => {
    it('resolveReferences() deletes unresolvable rows (parity with the batched path)', async () => {
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'app.ts'),
        [
          'export function helper() { return 1; }',
          'export function main() {',
          '  helper();',
          '  totallyUndefinedCall();', // resolves to nothing anywhere
          '}',
          '',
        ].join('\n')
      );

      cg = CodeGraph.initSync(testDir);
      await cg.indexAll();
      expect(cg.getPendingReferenceCount()).toBe(0);

      // Re-extract without resolving: both the resolvable helper() ref and
      // the unresolvable one are back in the table.
      await interruptAfterExtraction('src/app.ts');
      expect(cg.getPendingReferenceCount()).toBeGreaterThan(0);

      // The non-batched full pass (which also backs the git-scoped sync
      // path) must consume BOTH: pre-fix it deleted only resolved rows, so
      // unresolvable ones parked forever and defeated the orphan sweep's
      // "non-empty table means interrupted run" invariant.
      cg.resolveReferences();
      expect(cg.getPendingReferenceCount()).toBe(0);
    });

    it('batched resolution does not stop at an all-unresolvable batch', async () => {
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      // File A: only unresolvable refs. Extracted first, so its rows sort
      // first and fill the whole first batch.
      fs.writeFileSync(
        path.join(srcDir, 'a.ts'),
        [
          'export function a() {',
          '  ghostOne();',
          '  ghostTwo();',
          '  ghostThree();',
          '}',
          '',
        ].join('\n')
      );
      // File B: a resolvable ref whose rows sort after A's.
      fs.writeFileSync(
        path.join(srcDir, 'b.ts'),
        [
          "import { target } from './c';",
          'export function b() { target(); }',
          '',
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(srcDir, 'c.ts'),
        'export function target() { return 2; }\n'
      );

      cg = CodeGraph.initSync(testDir);
      await cg.indexAll();

      // Re-queue A's refs then B's, in that order.
      await interruptAfterExtraction('src/a.ts');
      await interruptAfterExtraction('src/b.ts');
      expect(cg.getPendingReferenceCount()).toBeGreaterThan(0);

      // Batch size 2 puts only A's unresolvable refs in the first batch.
      // The old early break ended the whole run there, leaving B's ref an
      // orphan even though the batch's rows WERE consumed (progress).
      const resolver = (cg as unknown as { resolver: { resolveAndPersistBatched(p?: unknown, b?: number): Promise<unknown> } }).resolver;
      await resolver.resolveAndPersistBatched(undefined, 2);

      expect(cg.getPendingReferenceCount()).toBe(0);
      const target = findMethod('target');
      expect(callerFiles(target)).toContain('src/b.ts');
    });
  });
});
