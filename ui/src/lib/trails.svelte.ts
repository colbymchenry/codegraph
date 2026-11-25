/**
 * The saved trails, as live state.
 *
 * Everything that decides what a row *says* is in `trails-model.ts`; this owns
 * the parts that need time — one fetch shared by every screen that lists them,
 * and the two writes.
 *
 * Two things it does deliberately:
 *
 * - **A write answers with the whole list, and the whole list is adopted.**
 *   Saving does not patch one row in place. The server re-resolves every hop of
 *   every trail on the way out, so a save is also the cheapest moment to learn
 *   that a trail saved last week has decayed — and patching locally would show
 *   a screen that had quietly stopped agreeing with the files on disk.
 * - **Failures are kept, not thrown away.** The one place in the viewer that
 *   can fail because of the *filesystem* (a read-only checkout, a full disk) is
 *   here, and "nothing happened" is the worst possible answer to a reader who
 *   just pressed Save.
 */

import { canWriteTrails, deleteTrail, fetchTrails, saveTrail, type WireTrail, type WireTrails } from './api';
import type { TrailHop } from './trail-codec';

let payload = $state<WireTrails | null>(null);
/** Null until the first attempt settles — the section says "reading" until then. */
let settled = $state(false);
let failure = $state<string | null>(null);
let busy = $state(false);

let inflight: Promise<void> | null = null;

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchTrails()
    .then((value) => {
      payload = value;
      failure = null;
    })
    .catch((cause: unknown) => {
      // A viewer whose trails cannot be listed still works; the section is the
      // only thing that has to know, and it prints the reason rather than an
      // empty box that looks like "you have never saved one".
      payload = null;
      failure = cause instanceof Error ? cause.message : String(cause);
    })
    .finally(() => {
      settled = true;
    });
  return inflight;
}

function adopt(next: WireTrails): void {
  payload = next;
  failure = null;
  settled = true;
  // The in-flight promise is the *load*; replacing the payload out from under
  // it is fine, but a later `ensure()` must not resolve to the stale one.
  inflight = Promise.resolve();
}

export const trails = {
  get list(): readonly WireTrail[] {
    return payload?.trails ?? [];
  },
  get payload(): WireTrails | null {
    return payload;
  },
  /** False until the first fetch settles, however it settled. */
  get settled(): boolean {
    return settled;
  },
  get failure(): string | null {
    return failure;
  },
  /** A save or a delete is in flight — the form disables itself. */
  get busy(): boolean {
    return busy;
  },
  /**
   * Whether the viewer offers to save at all.
   *
   * Two independent reasons it might not, and the screens distinguish them:
   * the adapter never offered a write ({@link canWriteTrails}), or the
   * answering side declined this one (`readOnly` on the payload). Until the
   * first fetch settles we assume it can, so the Save button does not flicker
   * into existence a moment after the trail bar draws.
   */
  get canSave(): boolean {
    if (!canWriteTrails()) return false;
    return payload === null || !payload.readOnly;
  },
  /**
   * Why saving is off, when it is.
   *
   * The answering side's own sentence wins when there is one — it is the more
   * specific truth, and it is the one that names the flag or the mount that
   * caused it. The generic line is only for an adapter that never offered a
   * write at all, which has nothing to say for itself.
   */
  get readOnlyReason(): string | null {
    if (payload?.readOnly) return payload.readOnlyReason ?? 'This viewer is running read-only.';
    if (!canWriteTrails()) return 'This viewer cannot save trails.';
    return null;
  },
  /** Where the files live, project-relative. Null until known. */
  get directory(): string | null {
    return payload?.directory ?? null;
  },

  /** Load once. Every screen that lists trails calls this. */
  ensure: load,

  /** Ask again, because the index moved or a file changed underneath us. */
  reload(): Promise<void> {
    inflight = null;
    return load();
  },

  /**
   * Save the walk under a name.
   *
   * Hops travel as ids and directions only — the answering side reads each
   * symbol's name, kind and file out of the graph, so a saved trail is always
   * something the index itself said.
   *
   * @returns the id written, or null when the save failed (see `failure`).
   */
  async save(name: string, note: string, hops: readonly TrailHop[]): Promise<string | null> {
    busy = true;
    try {
      const answer = await saveTrail({
        name,
        note,
        hops: hops.map((hop) => ({ dir: hop.dir, id: hop.id })),
      });
      adopt(answer);
      return answer.saved ?? null;
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
      return null;
    } finally {
      busy = false;
    }
  },

  /** Remove a saved trail. Returns whether it went. */
  async remove(id: string): Promise<boolean> {
    busy = true;
    try {
      adopt(await deleteTrail(id));
      return true;
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      busy = false;
    }
  },

  /** Drop the last failure, so a retry starts from a clean screen. */
  clearFailure(): void {
    failure = null;
  },
};
