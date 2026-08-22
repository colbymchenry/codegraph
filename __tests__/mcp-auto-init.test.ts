/**
 * Opt-in global auto-init (issue: codegraph indexing coverage — see
 * docs/superpowers/specs/2026-08-18-indexing-coverage-and-freshness-design.md).
 *
 * When `autoInit` is on (src/installer/user-config.ts), the MCP server
 * indexes an unindexed project on first query instead of just telling the
 * agent to run `codegraph init`. Default (off) behavior is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, __setAutoInitDirForTests, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import { setAutoInit } from '../src/installer/user-config';

function makeUnindexedRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-auto-init-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/main.ts'), 'export function main(){ return 1; }\n');
  return dir;
}

describe('MCP auto-init (opt-in)', () => {
  let repo: string;
  let configDir: string;
  let handler: ToolHandler;

  beforeEach(() => {
    repo = makeUnindexedRepo();
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-auto-init-config-'));
    __setAutoInitDirForTests(configDir);
    // Services ToolHandler's lazy cross-project require('../index'), which
    // vitest's module transform can't resolve in-process — same seam used by
    // mcp-stale-slice.test.ts for the same reason.
    __setLoadCodeGraphForTests(CodeGraph);
    handler = new ToolHandler(null);
  });

  afterEach(() => {
    __setAutoInitDirForTests(null);
    __setLoadCodeGraphForTests(null);
    // Close the auto-inited project's DB connection before removing its
    // directory — an open SQLite handle holds the directory locked on
    // Windows and rmSync fails EPERM otherwise (same class of issue the
    // mcp-unindexed/mcp-stale-slice suites document).
    try { handler.closeAll(); } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('leaves default (off) behavior unchanged: still asks the user to run codegraph init', async () => {
    const res = await handler.execute('codegraph_explore', { query: 'main', projectPath: repo });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/codegraph init/);
  });

  it('indexes the project automatically when autoInit is on', async () => {
    setAutoInit(true, { dir: configDir });

    const res = await handler.execute('codegraph_explore', { query: 'main', projectPath: repo });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).not.toMatch(/codegraph init/);
    expect(fs.existsSync(path.join(repo, '.codegraph'))).toBe(true);
    // Not just "a .codegraph/ dir exists" — the index must actually have
    // real content. A failed/empty indexAll would still create the
    // directory (and, pre-fix, was being cached and returned as if it had
    // succeeded), so assert the query resolved the real symbol.
    expect(res.content[0]!.text).toMatch(/main/);
  });

  it("a losing pool worker never deletes the winning worker's in-progress index", async () => {
    setAutoInit(true, { dir: configDir });

    // Every query-pool worker (src/mcp/query-worker.ts) builds its OWN
    // ToolHandler, so autoInitProject's in-flight de-dup map -- a per-instance
    // field -- does NOT de-dupe across workers. Two workers really can both
    // observe "not indexed" and both run CodeGraph.init + indexAll on the same
    // path. One wins the index file lock; the loser's indexAll RESOLVES
    // `{ success: false, errors: ['Could not acquire file lock ...'] }`
    // (src/index.ts) rather than throwing. Pre-fix, the loser's catch block
    // then rmSync'd the entire .codegraph/ -- the WINNER's live index, out
    // from under the winner's open SQLite handle.

    // --- The winner: a real, complete, queryable index. ---
    const won = await handler.execute('codegraph_explore', { query: 'main', projectPath: repo });
    expect(won.content[0]!.text).toMatch(/main/);
    const cgDir = path.join(repo, '.codegraph');

    // ...and it is still indexing. FileLock (src/utils.ts) is a lock FILE
    // holding the owner's pid; it treats a lock whose pid is alive as held.
    // Writing our own live pid is byte-for-byte what the winner's FileLock
    // writes while indexAll runs, so the loser below hits the real lock via
    // the real acquire() path -- nothing about the contention is faked.
    fs.writeFileSync(path.join(cgDir, 'codegraph.lock'), String(process.pid));

    const beforeLoser = fs.readdirSync(cgDir).sort();
    expect(beforeLoser).toContain('codegraph.db');

    // --- The loser: a second ToolHandler, i.e. a second pool worker. ---
    const handlerB = new ToolHandler(null);

    // One JS thread cannot produce the single interleave that matters: both
    // workers passing `isInitialized` before either created the directory
    // (CodeGraph.init throws "already initialized" for whoever checks second,
    // and a real Promise.all of two execute() calls just serializes). So stub
    // ONLY that step -- the loser's init hands back a real CodeGraph opened on
    // the same on-disk .codegraph/, exactly what its racing init would have
    // produced on a second thread. Everything downstream is unstubbed: the
    // real indexAll, the real FileLock contention, the real failure shape, and
    // the real cleanup branch under review.
    class RacingCodeGraph extends CodeGraph {
      static async init(root: string): Promise<CodeGraph> {
        return CodeGraph.openSync(root);
      }
    }
    __setLoadCodeGraphForTests(RacingCodeGraph as unknown as typeof CodeGraph);

    try {
      await expect(
        (handlerB as unknown as { autoInitProject(p: string): Promise<unknown> }).autoInitProject(repo),
      ).rejects.toThrow(/file lock|another process/i);

      // The winner's index is untouched -- not one file removed. Asserting the
      // whole directory listing rather than just codegraph.db matters on
      // Windows, where rmSync cannot unlink the open .db but WOULD still have
      // taken out every unopened sibling before failing.
      expect(fs.readdirSync(cgDir).sort()).toEqual(beforeLoser);
    } finally {
      __setLoadCodeGraphForTests(CodeGraph);
      try { handlerB.closeAll(); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(cgDir, 'codegraph.lock')); } catch { /* ignore */ }
    }

    // And it is still a REAL index on disk, not an unlinked inode the winner's
    // handle merely still points at: a fresh handler opens it from scratch.
    const verifier = new ToolHandler(null);
    try {
      const after = await verifier.execute('codegraph_explore', { query: 'main', projectPath: repo });
      expect(after.isError).toBeUndefined();
      expect(after.content[0]!.text).not.toMatch(/codegraph init/);
      expect(after.content[0]!.text).toMatch(/main/);
    } finally {
      try { verifier.closeAll(); } catch { /* ignore */ }
    }
  });

  it('still refuses to auto-init an unsafe path (home directory) even when autoInit is on', async () => {
    setAutoInit(true, { dir: configDir });

    const res = await handler.execute('codegraph_explore', { query: 'main', projectPath: os.homedir() });

    expect(res.content[0]!.text).toMatch(/codegraph init/);
    // NOT existsSync(homedir/.codegraph) alone: that directory already exists
    // on any machine that has used the codegraph CLI (it also holds
    // telemetry.json / config.json — global state unrelated to project
    // indexing). The precise signal that a PROJECT index was created there
    // is codegraph.db, the same marker `isInitialized` (src/directory.ts)
    // checks.
    expect(fs.existsSync(path.join(os.homedir(), '.codegraph', 'codegraph.db'))).toBe(false);
  });

  it('does not create anything under a sensitive, NONEXISTENT path even when autoInit is on', async () => {
    setAutoInit(true, { dir: configDir });

    // Pre-fix, getCodeGraph's auto-init branch only ran unsafeIndexRootReason
    // (home dir / parent-of-home / filesystem root) and — critically — skipped
    // validateProjectPath entirely for a path that doesn't exist yet (that skip
    // was safe before auto-init existed, when this branch was read-only: it let
    // a not-yet-real sub-path of a REAL project still walk up to a real
    // ancestor's .codegraph/, #238). unsafeIndexRootReason does NOT cover
    // ~/.ssh, ~/.aws, ~/.gnupg, ~/.config — only validateProjectPath does. So a
    // hallucinated projectPath under one of those (agents supply these
    // routinely) would have sailed past both checks and CodeGraph.init would
    // mkdirSync the whole missing chain into existence.
    const sensitiveTarget = path.join(os.homedir(), '.ssh', `codegraph-auto-init-attack-${Date.now()}`);
    expect(fs.existsSync(sensitiveTarget)).toBe(false);

    try {
      const res = await handler.execute('codegraph_explore', { query: 'main', projectPath: sensitiveTarget });

      expect(res.content[0]!.text).toMatch(/codegraph init/);
      expect(fs.existsSync(sensitiveTarget)).toBe(false);
    } finally {
      // Defensive cleanup in case this guard ever regresses — never leave
      // anything behind under the real ~/.ssh.
      fs.rmSync(sensitiveTarget, { recursive: true, force: true });
    }
  });
});
