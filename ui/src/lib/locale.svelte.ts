/**
 * Viewer localization — reactive surface for Svelte components.
 *
 * This is a THIN wrapper over the plain, rune-free `./locale` module, which
 * owns the message tables and the non-reactive `t()`/`tPair()`/`plural()`/
 * `hasPluralInflection()` builders. The engine's vitest project loads the
 * `lib/*-model.ts` files in plain Node with no Svelte plugin, so those models
 * import from `./locale`, never from here. Components, by contrast, need
 * reactivity: this file mirrors the current locale in `$state` and re-exports
 * locale-aware functions that read that mirror first (so any template that
 * calls them re-renders on switch) and then delegate to the plain
 * implementations.
 *
 * Symbol names, file paths, route paths and source code are NEVER translated;
 * only UI chrome (navigation, buttons, tooltips, empty states, errors) and the
 * sentence builders in the `lib/*-model.ts` files go through this table.
 */

import {
  t as plainT,
  tPair as plainTPair,
  plural as plainPlural,
  hasPluralInflection as plainHasPluralInflection,
  getCurrentLocale,
  setCurrentLocale,
} from './locale';
import type { LocaleCode } from './locale';

export type { LocaleCode } from './locale';

let currentLocaleMirror: LocaleCode = $state<LocaleCode>(getCurrentLocale());

export const locale = {
  get current(): LocaleCode {
    return currentLocaleMirror;
  },
  set(value: LocaleCode): void {
    currentLocaleMirror = value;
    setCurrentLocale(value);
  },
};

/** Look up a message for the current locale; interpolation via `{key}`. */
export function t(key: string, params?: Record<string, string | number>): string {
  currentLocaleMirror;
  return plainT(key, params);
}

/** Look up a message that ships as a [singular, plural] pair. */
export function tPair(key: string): [string, string] {
  currentLocaleMirror;
  return plainTPair(key);
}

/** Returns the count followed by the appropriately inflected noun. */
export function plural(count: number, one: string, many = `${one}s`): string {
  currentLocaleMirror;
  return plainPlural(count, one, many);
}

/** Whether the current language inflects plurals (English does; Chinese does not). */
export function hasPluralInflection(): boolean {
  currentLocaleMirror;
  return plainHasPluralInflection();
}
