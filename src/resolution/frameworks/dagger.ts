/**
 * Dagger 2 / Hilt resolver
 *
 * Lightweight detection + recognition of Dagger modules. Binding edges
 * (`interface → impl`) are actually emitted by the whole-graph synthesizer
 * pass in `callback-synthesizer.ts` — that needs every `@Module` class and
 * every `@Provides`/`@Binds` method in the project to reason about
 * disambiguation, which is awkward inside per-file `extract`. This resolver
 * is the architectural counterpart: it lets `detectFrameworks` advertise
 * "this project uses Dagger" and gives a stable name to register against.
 */

import { FrameworkResolver, ResolutionContext } from '../types';

const DAGGER_IMPORT_RE = /^import\s+dagger\./m;
const DAGGER_FILE_EXT_RE = /\.(?:java|kt)$/;

export const daggerResolver: FrameworkResolver = {
  name: 'dagger',
  languages: ['java', 'kotlin'],

  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      if (!DAGGER_FILE_EXT_RE.test(file)) continue;
      const content = context.readFile(file);
      if (content && DAGGER_IMPORT_RE.test(content)) return true;
    }
    return false;
  },

  // No per-reference resolution. Binding edges are emitted by the
  // synthesizer; ordinary symbol references fall through to the
  // standard import / name-matcher chain.
  resolve(): null {
    return null;
  },
};
