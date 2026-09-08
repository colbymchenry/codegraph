/**
 * The one transient message the viewer has: "Index updated · reloaded".
 *
 * A note, not a dialog — nothing was asked of the reader and nothing is waiting
 * on them. It replaces itself rather than stacking, because the only thing it
 * ever reports is the most recent state of one fact.
 */

/** How long a note stays up (design spec). */
export const TOAST_MS = 2_600;

let message = $state<string | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

function show(text: string): void {
  if (timer !== null) clearTimeout(timer);
  message = text;
  timer = setTimeout(() => {
    message = null;
    timer = null;
  }, TOAST_MS);
}

function clear(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  message = null;
}

export const toast = {
  get message(): string | null {
    return message;
  },
  show,
  clear,
};
