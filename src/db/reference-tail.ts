/**
 * The keys sync's failed-ref retry (#1240) matches on: the tail a failed ref
 * is parked under, and the names a newly added file can be imported as.
 * Shared by the query layer, which writes and reads them, and the migrations
 * that rewrote the tails parked before path imports, path references and
 * module references had ones of their own.
 */

/**
 * Last segment of a (possibly dotted/qualified) reference name — the part a
 * new symbol's plain node name could match: 'util.greet' → 'greet',
 * 'mod::fn' → 'fn', 'greet' → 'greet'. Written to unresolved_refs.name_tail
 * when a ref is marked failed, so the #1240 retry lookup can match dotted
 * refs against newly-added node names.
 *
 * An import written as a path names a FILE, so its tail is the path's last
 * segment cut at its first dot — `package:app/b.dart` → 'b', `./foo` → 'foo',
 * `inc/db.php` → 'db' — the stem {@link importPathKeys} takes from a file
 * that could satisfy it. The dotted tail was the extension ('dart', 'php') or
 * a path fragment ('/foo'), which no file ever matched.
 *
 * A route's reference to the module it lazily loads names a file the same
 * way, by the module's path with or without its extension: React Router's
 * `lazy-import:./pages/Team`, Vue Router's and Angular's
 * `import:./home/home.component#HomeComponent`. It is parked under that
 * path's stem behind 'module:' — 'module:Team', 'module:home' — the key
 * {@link moduleReferenceKeys} gives a file that could be the module. A bare
 * stem would be any symbol's name, which a module reference does not wait
 * for: 'index' and 'types' are the tails of thousands of failed calls. Its
 * dotted tail was a path fragment ('/pages/Team') or what follows the
 * module's own dot ('component#HomeComponent'), which no file ever matched.
 *
 * Any other reference written as a path to a file names it by the file's own
 * name: Liquid's `{% render 'price' %}` is `snippets/price.liquid`, parked as
 * 'price.liquid' — the name path matching looks the file up by, and the name
 * of the node a file that appears later is given. Its dotted tail was the
 * extension, 'liquid'. A call's slashes are in its arguments, a comment or a
 * division, so only a `references` ref is read as a path.
 */
export function referenceNameTail(referenceName: string, referenceKind?: string): string {
  if (referenceKind === 'imports' && referenceName.replace(/\/+$/, '').includes('/')) {
    const stem = pathStem(referenceName);
    if (stem) return stem;
  }
  // Vue Router's route names the component it renders as a call.
  if (referenceKind === 'references' || referenceKind === 'calls') {
    const route = MODULE_REFERENCE.exec(referenceName);
    const stem = route ? pathStem(route[1] ?? route[2]!) : '';
    if (stem) return MODULE_KEY + stem;
  }
  if (referenceKind === 'references') {
    const fileName = referenceName.slice(referenceName.lastIndexOf('/') + 1);
    if (fileName !== referenceName && FILE_NAME.test(fileName)) return fileName;
  }
  // Erlang refs carry a written arity (`f/1`, `mod::fn/2` — #1610); the tail a
  // new symbol's plain name could match is the arity-less function name.
  const base = referenceName.replace(/\/\d{1,3}$/, '') || referenceName;
  const idx = Math.max(base.lastIndexOf('.'), base.lastIndexOf(':'));
  return idx >= 0 ? base.slice(idx + 1) : base;
}

/** A file name with an extension: 'price.liquid', 'icon.logo.liquid', 'about.tsx' — not 'x.component#Name'. */
const FILE_NAME = /^[\w$@+~.-]+\.[A-Za-z][A-Za-z0-9]*$/;

/**
 * A route's reference to the module it lazily loads, capturing the module's
 * path: React Router's `lazy-import:<path>`, Vue Router's and Angular's
 * `import:<path>#<export>` — a path may hold a `#` itself, as vben's `#/views/…`
 * alias does — each also behind `layout:`, for a layout route's module.
 */
const MODULE_REFERENCE = /^(?:layout:)?(?:lazy-import:(.+)|import:(.+)#[^#]+)$/;

/** What a module reference's tail starts with. No symbol's name does, so a lookup by symbol names never finds one. */
const MODULE_KEY = 'module:';

/** A path's last segment up to its first dot — `./pages/Team` → 'Team', `a/b.dart` → 'b' — or '' when that is only dots. */
function pathStem(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const stem = fileNameStem(trimmed.slice(trimmed.lastIndexOf('/') + 1));
  // `..` and `.` name a folder only through the referring file's location.
  return /^\.*$/.test(stem) ? '' : stem;
}

/** A file or folder name up to its first dot: 'b.dart' → 'b', 'types.d.ts' → 'types', '.eslintrc.js' → '.eslintrc'. */
function fileNameStem(name: string): string {
  const dot = name.indexOf('.', 1);
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * What an import of the file at `filePath` can be written as, for the failed
 * imports a sync that adds the file retries: its name (`b.h`, a bare include)
 * and stem (`b`, the tail of `a/b.h`, `./b`, `pkg.b`), and the same two for
 * its folder, which an import names for its index file (`./ui` →
 * `ui/index.ts`, `pkg` → `pkg/__init__.py`) or as a Go package.
 */
export function importPathKeys(filePath: string): string[] {
  const parts = filePath.split('/');
  const keys = new Set<string>();
  for (const name of parts.slice(-2)) {
    keys.add(name);
    keys.add(fileNameStem(name));
  }
  return [...keys];
}

/**
 * The keys a module reference the file at `filePath` could satisfy is parked
 * under: its {@link importPathKeys} behind 'module:' — `src/pages/Team.tsx`
 * is the module of `lazy-import:./pages/Team`, `pages/Team/index.tsx` of the
 * same path through its folder. A sync looks them up for the files it adds
 * AND the ones it changes: a route renders the component its module exports,
 * so an edit that gives the module one is what the route waited for.
 */
export function moduleReferenceKeys(filePath: string): string[] {
  return importPathKeys(filePath).map((key) => MODULE_KEY + key);
}
