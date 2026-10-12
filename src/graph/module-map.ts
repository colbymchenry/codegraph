/**
 * File → module assignment, shared by the viewer's map and the architecture report.
 *
 * The rule is the same in both places: a module is a directory, not a guess. A file maps to the
 * first `depth` path segments under the chosen root, a level being one folder plus any
 * pass-through folder that follows it; a loose file folds into a `(root files)` bucket, except a
 * façade (`index.ts`, `lib.rs`, `__init__.py`) which is a box of its own.
 *
 * This lived in `src/ui-server/api/map.ts` until the CLI/MCP architecture report needed the same
 * grouping. Keeping one implementation is what stops the map and the report from disagreeing
 * about what "module" means.
 */

/** Normalize backslashes so the same path is one module on every platform. */
export const toPosixPath = (p: string): string => p.replace(/\\/g, '/');

/**
 * Basenames that stay their own box when they sit loose in a module root.
 *
 * These are façades — the file every other module imports the directory
 * *through*. Folding `src/index.ts` into a "(root files)" bucket with the type
 * declarations next to it hides the busiest node on the map.
 */
export const FACADE_STEMS = new Set(['index', 'main', 'lib', 'mod', '__init__', 'init']);

/** Id of the bucket loose files fall into. Deliberately not a real directory name. */
export function rootFilesId(root: string): string {
  return root ? `${root}/(root files)` : '(root files)';
}

/** Strip a trailing slash and any leading `./`, so `src/` and `src` are one root. */
export function normalizeRoot(raw: string | undefined): string {
  let root = (raw ?? '').trim().replace(/\\/g, '/');
  while (root.startsWith('./')) root = root.slice(2);
  while (root.endsWith('/')) root = root.slice(0, -1);
  if (root === '.' || root === '/') return '';
  return root;
}

function stemOf(basename: string): string {
  const dot = basename.indexOf('.');
  return dot <= 0 ? basename : basename.slice(0, dot);
}

/**
 * Directories a module boundary never falls on: exactly one subdirectory and
 * no file of their own. A Maven project keeps every line of Java under
 * `src/main/java/org/springframework/samples/petclinic/`, and the first four
 * of those folders split nothing — cutting at any of them draws the whole
 * program as one box, and no depth the reader can pick gets past them. Such a
 * folder joins the level below it, so depth counts folders that fork.
 *
 * Read from every indexed file, tests included, so a module's id does not
 * change when the reader toggles tests. The repository root is never one.
 */
export function passThroughDirs(paths: Iterable<string>): Set<string> {
  const children = new Map<string, Set<string>>();
  const holdsFiles = new Set<string>();
  for (const raw of paths) {
    const parts = toPosixPath(raw).split('/').filter(Boolean);
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      let kids = children.get(dir);
      if (!kids) children.set(dir, (kids = new Set()));
      kids.add(parts[i]!);
      dir = dir ? `${dir}/${parts[i]}` : parts[i]!;
    }
    holdsFiles.add(dir);
  }
  const out = new Set<string>();
  for (const [dir, kids] of children) {
    if (dir !== '' && kids.size === 1 && !holdsFiles.has(dir)) out.add(dir);
  }
  return out;
}

/**
 * Where each level of a file's directory path ends, as indexes into `dirs`: a
 * level is one folder plus every pass-through folder that follows it.
 */
export function levelEnds(root: string, dirs: readonly string[], passThrough: ReadonlySet<string> | undefined): number[] {
  const ends: number[] = [];
  for (let i = 0; i < dirs.length; ) {
    i++;
    while (passThrough && i < dirs.length && passThrough.has(joinPath(root, dirs.slice(0, i)))) i++;
    ends.push(i);
  }
  return ends;
}

function joinPath(root: string, segments: readonly string[]): string {
  return [root, ...segments].filter(Boolean).join('/');
}

/** The first `levels` levels of `dirs`, a chain of three or more folders written `first/…/last`. */
function levelLabel(root: string, dirs: readonly string[], ends: readonly number[]): string {
  const out: string[] = root ? [root] : [];
  let from = 0;
  for (const end of ends) {
    const chain = dirs.slice(from, end);
    out.push(chain.length >= 3 ? `${chain[0]}/…/${chain[chain.length - 1]}` : chain.join('/'));
    from = end;
  }
  return out.join('/');
}

/**
 * Which module a file belongs to, or `null` when it is outside the root.
 *
 * `depth` levels under the root name the module — a level being a folder and
 * the {@link passThroughDirs} that follow it (without them, one level per
 * folder). A file with fewer levels than that is loose in the root: a façade
 * keeps its own box, everything else joins the `(root files)` bucket.
 */
export function moduleIdFor(
  filePath: string,
  root: string,
  depth: number,
  passThrough?: ReadonlySet<string>
): { id: string; facade: boolean; label: string } | null {
  const path = toPosixPath(filePath);
  let rel = path;
  if (root) {
    if (!path.startsWith(`${root}/`)) return null;
    rel = path.slice(root.length + 1);
  }
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const dirs = parts.slice(0, -1);
  const ends = levelEnds(root, dirs, passThrough);
  if (ends.length < depth) {
    // A loose file. The directories it DOES have still qualify it, so
    // `src/a/b.ts` at depth 2 lands in `src/a/(root files)`, not the top one.
    const dir = joinPath(root, dirs);
    const dirLabel = levelLabel(root, dirs, ends);
    const file = parts[parts.length - 1] ?? '';
    if (FACADE_STEMS.has(stemOf(file))) {
      return { id: joinPath(root, parts), facade: true, label: dirLabel ? `${dirLabel}/${file}` : file };
    }
    return { id: rootFilesId(dir), facade: false, label: rootFilesId(dirLabel) };
  }
  return {
    id: joinPath(root, dirs.slice(0, ends[depth - 1])),
    facade: false,
    label: levelLabel(root, dirs, ends.slice(0, depth)),
  };
}

/**
 * Rename `x/(root files)` to `x` wherever the bucket is all `x` has.
 *
 * The bucket earns its name only when it stands beside something: `src` holding
 * both `src/api` and three loose files needs a box for the loose ones, and that
 * box has to say it is not the whole of `src`. But a `backend/controllers` with
 * no subdirectories in it is not a directory with a bucket in it — it IS the
 * directory, and drawing it as `backend/controllers/(root files)` names a thing
 * the repository does not have. Deeper groupings hit this constantly (every
 * leaf directory becomes a bucket), which is what makes it worth a pass.
 *
 * Returns only the ids that move, so a caller can leave the rest alone.
 */
export function collapseLoneRootFiles(ids: ReadonlySet<string>): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const id of ids) {
    const cut = id.lastIndexOf('/(root files)');
    // A bucket at the very top (`(root files)`) has no directory to become.
    if (cut <= 0 || cut + '/(root files)'.length !== id.length) continue;
    const dir = id.slice(0, cut);
    let alone = true;
    for (const other of ids) {
      // A façade counts: `src/utils` beside `src/utils/index.tsx` would read as
      // if the box contained the file drawn next to it.
      if (other !== id && other.startsWith(`${dir}/`)) {
        alone = false;
        break;
      }
    }
    // `dir` can only already be a module if something lives BELOW it, which is
    // exactly the case `alone` just ruled out — so this rename cannot collide.
    if (alone) renamed.set(id, dir);
  }
  return renamed;
}

// =============================================================================
// Which grouping to draw when the reader named none
// =============================================================================

/** A file as the grouping rules see it: where it is, how big it is, whether it is program. */
export interface ModuleViewFile {
  path: string;
  symbols: number;
  test: boolean;
}

/** Default segments below the root that name a module. */
export const DEFAULT_MODULE_DEPTH = 1;
export const MAX_MODULE_DEPTH = 4;

/**
 * A box holding more than this share of the mapped symbols IS the program, and
 * a map whose subject is one box has not said anything.
 */
const DOMINANT_SHARE = 0.4;

/**
 * …but only if there is something inside it. A dominant box of four files is a
 * small project honestly drawn; opening it just spreads four files over four
 * boxes. This is the line between "grouped too coarsely" and "actually small".
 */
const DOMINANT_MIN_FILES = 25;

/** Fewer boxes than this is a list, not a picture. */
const MIN_MODULES = 4;

/** More than this and a deeper grouping has traded one unreadable map for another. */
const MAX_MODULES = 60;

/**
 * The root to open on: the directory holding the most non-test symbols.
 *
 * A repository's source almost always lives under one directory (`src`, `lib`,
 * `pkg`, `app`), and opening there is what keeps the default view about the
 * program rather than about its tests, scripts and sibling packages. The
 * fallback is the repository root, which is correct for a flat project.
 *
 * A directory only wins if it holds a clear majority of the symbols — anything
 * less and the honest answer is "this repository has no single source root".
 */
export function pickDefaultRoot(files: ReadonlyArray<ModuleViewFile>): string {
  const byDir = new Map<string, number>();
  let total = 0;
  for (const file of files) {
    if (file.test) continue;
    // A file loose in the repository root is program too: git's hundreds of
    // top-level `.c` files made `builtin/` look like the majority of the code.
    total += file.symbols;
    const slash = file.path.indexOf('/');
    if (slash <= 0) continue;
    const dir = file.path.slice(0, slash);
    byDir.set(dir, (byDir.get(dir) ?? 0) + file.symbols);
  }
  if (total === 0) return '';
  let best = '';
  let bestSymbols = 0;
  let second = 0;
  for (const [dir, symbols] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (symbols > bestSymbols) {
      second = bestSymbols;
      best = dir;
      bestSymbols = symbols;
    } else if (symbols > second) second = symbols;
  }
  // A second root holding a fifth of the code (a React Native app's `ios/`
  // beside its `src/`) belongs on the picture: map the whole project.
  if (second * 5 >= total) return '';
  return bestSymbols * 2 > total ? best : '';
}

/** The non-test modules a given depth would draw, and how concentrated they are. */
function tallyModules(
  files: ReadonlyArray<ModuleViewFile>,
  root: string,
  depth: number,
  passThrough?: ReadonlySet<string>
): { count: number; share: number; largestFiles: number } {
  const byModule = new Map<string, { symbols: number; files: number }>();
  let total = 0;
  for (const file of files) {
    if (file.test) continue;
    const assigned = moduleIdFor(file.path, root, depth, passThrough);
    if (assigned === null) continue;
    let entry = byModule.get(assigned.id);
    if (!entry) byModule.set(assigned.id, (entry = { symbols: 0, files: 0 }));
    entry.symbols += file.symbols;
    entry.files += 1;
    total += file.symbols;
  }
  let largest = { symbols: 0, files: 0 };
  for (const entry of byModule.values()) {
    if (entry.symbols > largest.symbols) largest = entry;
  }
  return {
    count: byModule.size,
    share: total === 0 ? 0 : largest.symbols / total,
    largestFiles: largest.files,
  };
}

/**
 * How many segments name a module, when the reader has not said.
 *
 * Depth is not a property of the reader's taste, it is a property of the
 * repository: one level under the root is the right grouping for a project
 * whose directories ARE its modules, and the wrong one for the very common
 * shape where every line of the program lives under a single `src/`. Drawing
 * that project at depth 1 produces the map this rule exists to prevent — a box
 * labelled `src`, holding two thirds of the code, with nothing to say about it.
 *
 * So: take the shallowest depth that is neither dominated by one box worth
 * opening nor too small to be a picture; stop before a deeper one becomes a
 * crowd; and never go past the last level the directory tree actually has.
 *
 * The walk does NOT stop at the first depth that fails to add boxes. A repo
 * packaged as `frontend/src/...` plateaus at two boxes for two levels running
 * before the third splits it, and a rule that gave up on the plateau would
 * draw exactly the picture this function exists to avoid.
 */
export function pickDefaultDepth(
  files: ReadonlyArray<ModuleViewFile>,
  root: string,
  passThrough?: ReadonlySet<string>
): number {
  // Past the deepest directory, a bigger number only renames boxes to
  // `src/a/(root files)`. There is nothing below the leaves.
  let deepest = DEFAULT_MODULE_DEPTH;
  for (const file of files) {
    if (file.test) continue;
    const path = toPosixPath(file.path);
    if (root && !path.startsWith(`${root}/`)) continue;
    const rel = root ? path.slice(root.length + 1) : path;
    const dirs = rel.split('/').filter(Boolean).slice(0, -1);
    deepest = Math.max(deepest, levelEnds(root, dirs, passThrough).length);
  }

  let fallback = DEFAULT_MODULE_DEPTH;
  let fallbackCount = 0;
  for (let depth = DEFAULT_MODULE_DEPTH; depth <= Math.min(MAX_MODULE_DEPTH, deepest); depth += 1) {
    const tally = tallyModules(files, root, depth, passThrough);
    if (tally.count === 0) break;
    // Deeper only gets more crowded from here.
    if (tally.count > MAX_MODULES) break;
    const dominated = tally.share > DOMINANT_SHARE && tally.largestFiles >= DOMINANT_MIN_FILES;
    if (tally.count >= MIN_MODULES && !dominated) return depth;
    // Not a picture yet. Worth keeping only if it drew more than the last one:
    // a deeper grouping that splits nothing is the same map with longer labels.
    if (tally.count > fallbackCount) {
      fallback = depth;
      fallbackCount = tally.count;
    }
  }
  return fallback;
}

/**
 * The root and depth to open on when the reader named neither.
 *
 * A source directory whose files all sit in one folder — Express's `lib/`, an
 * R package's `R/`, an Erlang app's `src/`, fmt's `include/fmt/` — draws as one
 * box at any depth, and a map whose subject is one box has said nothing. The
 * repository around it (that folder beside a CLI, a `src/`, the examples) is
 * then the picture worth opening on, when it draws more than one box.
 */
export function pickDefaultView(
  files: ReadonlyArray<ModuleViewFile>,
  passThrough?: ReadonlySet<string>
): { root: string; depth: number } {
  const root = pickDefaultRoot(files);
  const depth = pickDefaultDepth(files, root, passThrough);
  if (root === '' || tallyModules(files, root, depth, passThrough).count > 1) return { root, depth };
  const wholeDepth = pickDefaultDepth(files, '', passThrough);
  return tallyModules(files, '', wholeDepth, passThrough).count > 1 ? { root: '', depth: wholeDepth } : { root, depth };
}
