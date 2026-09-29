/**
 * Teardown for tests whose `serve --mcp` launchers race to spawn the shared
 * daemon (#1773). Each launcher that finds no daemon spawns a detached
 * candidate; one wins the lock and the rest exit once they see it. Stopping the
 * winner while a loser is still starting lets that loser take over the fixture
 * being removed, and on Windows a live process whose working directory is the
 * fixture makes the removal fail with EBUSY or EPERM. So the teardown waits for
 * the losers, by pid, before it stops the winner.
 */
import * as fs from 'fs';
import * as path from 'path';

const SPAWN_RECORDER = path.resolve(__dirname, 'fixtures/record-detached-spawns.cjs');

/** Where launchers started for `fixture` record their candidates: beside it, never inside. */
export function spawnLogFor(fixture: string): string {
  return path.join(path.dirname(fixture), `${path.basename(fixture)}.daemon-spawns`);
}

/** Node arguments and environment that make a launcher record its candidates. */
export function recordSpawns(fixture: string): { args: string[]; env: NodeJS.ProcessEnv } {
  return { args: ['--require', SPAWN_RECORDER], env: { CG_TEST_SPAWN_LOG: spawnLogFor(fixture) } };
}

function recordedPids(fixture: string): number[] {
  let raw = '';
  try { raw = fs.readFileSync(spawnLogFor(fixture), 'utf8'); } catch { return []; }
  return raw.split('\n').map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Resolve once every recorded candidate except the current lock holder has
 * exited. Call it after the launchers have exited, so no new candidate can
 * appear. The losers leave on their own; this never signals one, so a loser
 * that stays alive fails the teardown instead of being hidden.
 */
export async function settleLosingCandidates(
  fixture: string,
  holder: () => number | null | undefined,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = holder();
    const pending = recordedPids(fixture).filter((pid) => pid !== current && isAlive(pid));
    if (pending.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`Daemon candidates ${pending.join(', ')} were still running with ${current ?? 'no process'} holding the lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Remove the spawn record once the fixture's processes are gone. */
export function removeSpawnLog(fixture: string): void {
  fs.rmSync(spawnLogFor(fixture), { force: true });
}
