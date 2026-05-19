#!/usr/bin/env bun
/**
 * CodeGraph preuninstall cleanup script
 *
 * Runs automatically when `bun uninstall -g @colbymchenry/codegraph`
 * is called. Loops over every known agent target's `uninstall(loc)`
 * for the global location only — local-location entries live inside
 * project working trees and aren't ours to nuke at npm-uninstall
 * time.
 *
 * This script must never throw — a failed cleanup must not block
 * uninstall.
 */

try {
  // Lazy require so any module-level error in the registry can't
  // bubble out and abort the npm uninstall.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ALL_TARGETS } = require('../installer/targets/registry') as
    typeof import('../installer/targets/registry');

  for (const target of ALL_TARGETS) {
    if (!target.supportsLocation('global')) continue;
    try {
      target.uninstall('global');
    } catch {
      // Each target is independently safe-to-skip; per-target failure
      // must not stop the loop.
    }
  }
} catch {
  // If the registry itself can't be loaded (e.g. partial install),
  // we silently skip cleanup. Uninstall still completes.
}
