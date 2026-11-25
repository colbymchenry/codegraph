/**
 * CommonJS `require('…')` as an import.
 *
 * An ESM `import … from './application'` is an `import_statement` the
 * extractor turns into an `imports` reference from the file, which the import
 * resolver lands on the module's file. A `require('./application')` is just a
 * call, so a CommonJS file depended on nothing at file level: Express's
 * `lib/express.js` requires `./application`, `./request` and `./response` and
 * the index said it imports nothing — an empty Imports rail in the viewer, no
 * link on the Map, and no file dependency for impact. A binding used only as a
 * value (`mixin(app, proto)`) never made a call edge to stand in for it either.
 *
 * Read from the source after extraction rather than in a walker, so the wasm
 * extractor and the native kernel get it alike — including the kernel's
 * deferred-decode transport, which carries these beside its buffers. Only the
 * module's own file reference is emitted — the names a binding is called
 * through already resolve through the require binding (import-resolver's
 * CommonJS reader).
 */

import type { Language, UnresolvedReference } from '../types';
import { stripCommentsForRegex } from '../resolution/strip-comments';

const COMMONJS_LANGUAGES: ReadonlySet<Language> = new Set(['javascript', 'jsx', 'typescript', 'tsx']);

/**
 * `require('x')` with a literal specifier, not a member's (`foo.require(…)`)
 * or a property (`require.resolve(…)`). A template literal counts only when
 * it has no `${…}` hole.
 */
const REQUIRE_CALL = /(?<![\w$.])require\s*\(\s*(?:'([^'\n]+)'|"([^"\n]+)"|`([^`$\n]+)`)\s*\)/g;

/**
 * A module of this project: a relative or rooted path, or a project alias
 * (`@/lib/x`, `~/x`, `#internal`). A package (`express`, `lodash/fp`) is
 * outside the index — as a name it would only match some same-named symbol.
 */
const LOCAL_SPECIFIER = /^(?:\.{1,2}(?:\/|$)|\/|[@~]\/|#)/;

/** `import x = require('y')` is TypeScript's import-equals: an `import_statement` already. */
const IMPORT_EQUALS = /\bimport\s+(?:type\s+)?[\w$]+\s*=\s*$/;

/** The file node both extractors mint: `file:<path>`. */
export function commonJsRequireRefs(filePath: string, source: string, language: Language): UnresolvedReference[] {
  if (!COMMONJS_LANGUAGES.has(language) || !source.includes('require')) return [];
  const safe = stripCommentsForRegex(source, language === 'javascript' || language === 'jsx' ? 'javascript' : 'typescript');
  const out: UnresolvedReference[] = [];
  const seen = new Set<string>();
  REQUIRE_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REQUIRE_CALL.exec(safe)) !== null) {
    const specifier = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!LOCAL_SPECIFIER.test(specifier) || seen.has(specifier)) continue;
    const lineStart = safe.lastIndexOf('\n', m.index - 1) + 1;
    if (IMPORT_EQUALS.test(safe.slice(lineStart, m.index))) continue;
    seen.add(specifier);
    out.push({
      fromNodeId: `file:${filePath}`,
      referenceName: specifier,
      referenceKind: 'imports',
      line: safe.slice(0, m.index).split('\n').length,
      column: m.index - lineStart,
      filePath,
      language,
    });
  }
  return out;
}
