/**
 * Locating the built browser viewer on disk.
 *
 * The viewer is a static Vite build that ships inside the package, exactly like
 * `schema.sql` and the tree-sitter grammars: emitted into `dist/viewer/`,
 * copied wholesale by `scripts/build-bundle.sh`, packed by
 * `scripts/pack-npm.sh`. So it is found the same way `db/index.ts` finds
 * `schema.sql` — relative to `__dirname`, never to `process.cwd()`, which is
 * whatever directory the user happened to be standing in.
 *
 * `dist/viewer`, NOT `dist/ui`: `src/ui/` is the engine's TERMINAL ui and tsc
 * already compiles it to `dist/ui/`. See `ui/vite.config.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { VIEWER_PATH_ENV } from './constants';

export { VIEWER_PATH_ENV };

/**
 * The viewer build is missing — the package was assembled without it, or the
 * repo was built with `tsc` alone. Carries user-facing remediation rather than
 * a stack trace, because the CLI prints `.message` verbatim.
 */
export class ViewerMissingError extends Error {
  constructor(searched: readonly string[]) {
    super(
      'The CodeGraph viewer assets are missing from this installation.\n' +
        'Looked in:\n' +
        searched.map((p) => `  ${p}`).join('\n') +
        '\n\nIf you installed CodeGraph normally, reinstall it — the release bundle ' +
        'ships the viewer.\nIf you are working from a source checkout, run: npm run build'
    );
    this.name = 'ViewerMissingError';
  }
}

/**
 * Candidate locations for the viewer, most-specific first.
 *
 * 1. The `CODEGRAPH_VIEWER_PATH` override.
 * 2. `<__dirname>/../viewer` — the shipped layout (`dist/ui-server/` →
 *    `dist/viewer/`).
 * 3. `<__dirname>/../../dist/viewer` — running the TypeScript straight out of
 *    `src/` (vitest, tsx), where `__dirname` is `src/ui-server/`.
 */
export function viewerDirCandidates(): string[] {
  const override = process.env[VIEWER_PATH_ENV]?.trim();
  const candidates = [
    path.join(__dirname, '..', 'viewer'),
    path.join(__dirname, '..', '..', 'dist', 'viewer'),
  ];
  return override ? [path.resolve(override), ...candidates] : candidates;
}

/**
 * Resolve the directory holding the built viewer.
 *
 * @throws {ViewerMissingError} when no candidate contains an `index.html`.
 */
export function resolveViewerDir(): string {
  const candidates = viewerDirCandidates();
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'index.html')).isFile()) {
        // realpath so the containment checks in `security.ts` compare like for
        // like when the install lives behind a symlink (Homebrew, nvm, pnpm).
        return fs.realpathSync(dir);
      }
    } catch {
      // Not here — try the next candidate.
    }
  }
  throw new ViewerMissingError(candidates);
}
