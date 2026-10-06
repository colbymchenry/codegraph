/**
 * Which files' top-level declarations a Dart file can name without a prefix.
 *
 * A Dart library is a file and its `part`s. Its top-level scope holds its own
 * declarations, private `_` names included, and every name exported by a
 * library it imports without a prefix: that library's own public declarations
 * and, through its `export`s, other libraries'. Every import and export is
 * narrowed by its `show` / `hide` combinators. A conditional import (`import
 * 'stub.dart' if (dart.library.io) 'io.dart'`) brings in every alternative.
 * `dart:` libraries and packages outside the repository (flutter, test,
 * mockito, …) export nothing of the project.
 *
 * `package:<name>/<path>` is `<root>/lib/<path>` of the package whose
 * pubspec.yaml says `name: <name>`: the nearest pubspec.yaml above an indexed
 * .dart file, never above the project root. When packages share a name
 * (example apps), the importing file's own package wins, then the one
 * enclosing it, else all of them count.
 *
 * Directives are read from the head of each file at resolution time;
 * extraction, and the kernel's, are unchanged. Where the library cannot be
 * established — a `part of` naming no library this can find, a file it cannot
 * read, a file in no package — every file counts as visible, so the rule only
 * narrows where the library is known.
 */
import * as path from 'path';
import type { ResolutionContext } from './types';

/** The names an import's or export's `show` / `hide` combinators let through; `show` null lets every name through. */
export interface NameFilter {
  readonly show: ReadonlySet<string> | null;
  readonly hide: ReadonlySet<string> | null;
  /** Identifies equal filters, so a namespace keeps each once. */
  readonly key: string;
}

const EVERY_NAME: NameFilter = { show: null, hide: null, key: '*|' };

function makeFilter(show: ReadonlySet<string> | null, hide: ReadonlySet<string> | null): NameFilter {
  const hidden = hide && hide.size > 0 ? hide : null;
  if (show === null && hidden === null) return EVERY_NAME;
  return { show, hide: hidden, key: `${show ? [...show].sort().join(',') : '*'}|${hidden ? [...hidden].sort().join(',') : ''}` };
}

/** `a`, then `b`: a name gets through when both let it. */
function composeFilters(a: NameFilter, b: NameFilter): NameFilter {
  if (a === EVERY_NAME) return b;
  if (b === EVERY_NAME) return a;
  const show = a.show && b.show ? new Set([...a.show].filter((n) => b.show!.has(n))) : (a.show ?? b.show);
  const hide = a.hide && b.hide ? new Set([...a.hide, ...b.hide]) : (a.hide ?? b.hide);
  return makeFilter(show, hide);
}

function lets(filter: NameFilter, name: string): boolean {
  return (filter.show === null || filter.show.has(name)) && (filter.hide === null || !filter.hide.has(name));
}

/** An `import` or `export` directive. */
export interface DartNamespaceDirective {
  /** The URI, then each conditional alternative (`if (dart.library.io) 'io.dart'`). */
  uris: string[];
  /** The prefix of `import '…' as p`, or null. */
  prefix: string | null;
  filter: NameFilter;
}

/** The directives at the head of a Dart file. */
export interface DartDirectives {
  /** `library a.b;` gives `a.b`, `library;` gives '', no directive null. */
  libraryName: string | null;
  partOf: { uri: string } | { name: string } | null;
  parts: string[];
  imports: DartNamespaceDirective[];
  exports: DartNamespaceDirective[];
}

const DIRECTIVE_KEYWORDS: ReadonlySet<string> = new Set(['library', 'import', 'export', 'part']);
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;

/** The index past the whitespace and comments at `i` (Dart block comments nest). */
function skipTrivia(src: string, i: number): number {
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || c === 0xfeff) {
      i++;
    } else if (c === 47 && src.charCodeAt(i + 1) === 47) {
      const newline = src.indexOf('\n', i + 2);
      i = newline < 0 ? n : newline + 1;
    } else if (c === 47 && src.charCodeAt(i + 1) === 42) {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src.charCodeAt(i) === 47 && src.charCodeAt(i + 1) === 42) {
          depth++;
          i += 2;
        } else if (src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
    } else {
      break;
    }
  }
  return i;
}

/** The string literal at `i` — `'…'`, `"…"`, triple-quoted or raw — as its value and the index past it, or null. */
function readString(src: string, i: number): { value: string; end: number } | null {
  let raw = false;
  if (src[i] === 'r' && (src[i + 1] === "'" || src[i + 1] === '"')) {
    raw = true;
    i++;
  }
  const quote = src[i];
  if (quote !== "'" && quote !== '"') return null;
  const close = src.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
  let j = i + close.length;
  let value = '';
  while (j < src.length) {
    if (src.startsWith(close, j)) return { value, end: j + close.length };
    const c = src[j]!;
    if (c === '\n' && close.length === 1) return null;
    if (c === '\\' && !raw) {
      value += src[j + 1] ?? '';
      j += 2;
    } else if (c === '$' && !raw && src[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < src.length && depth > 0) {
        const inner = readString(src, j);
        if (inner) {
          j = inner.end;
          continue;
        }
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
    } else {
      value += c;
      j++;
    }
  }
  return null;
}

/** The index past the balanced `open` … `close` group at `i`, strings and comments skipped; -1 if it never closes. */
function skipGroup(src: string, i: number, open: string, close: string): number {
  let depth = 0;
  while (i < src.length) {
    i = skipTrivia(src, i);
    const literal = readString(src, i);
    if (literal) {
      i = literal.end;
      continue;
    }
    const c = src[i];
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

/** The index past the metadata annotation at `i` (`@TestOn('vm')`, `@Tags(['slow'])`, `@JS()`). */
function skipAnnotation(src: string, i: number): number {
  i++;
  for (;;) {
    i = skipTrivia(src, i);
    IDENTIFIER.lastIndex = i;
    const name = IDENTIFIER.exec(src);
    if (!name) return i;
    i += name[0].length;
    const next = skipTrivia(src, i);
    if (src[next] !== '.') break;
    i = next + 1;
  }
  i = skipTrivia(src, i);
  if (src[i] === '<') {
    const end = skipGroup(src, i, '<', '>');
    if (end < 0) return src.length;
    i = skipTrivia(src, end);
  }
  if (src[i] === '(') {
    const end = skipGroup(src, i, '(', ')');
    return end < 0 ? src.length : end;
  }
  return i;
}

type DirectiveToken =
  | { kind: 'string'; value: string }
  | { kind: 'word'; value: string }
  | { kind: 'condition' }
  | { kind: 'punctuation'; value: string };

/**
 * The tokens of a directive, from just past its keyword to its `;`, and the
 * index past that `;` — or null when a body (`{`, `=>`) comes first, as in a
 * function named `part`, or the file ends.
 */
function readDirectiveTokens(src: string, i: number): { tokens: DirectiveToken[]; end: number } | null {
  const tokens: DirectiveToken[] = [];
  for (;;) {
    i = skipTrivia(src, i);
    if (i >= src.length || tokens.length > 2000) return null;
    const c = src[i]!;
    if (c === ';') return { tokens, end: i + 1 };
    if (c === '{' || c === '}' || (c === '=' && src[i + 1] === '>')) return null;
    const literal = readString(src, i);
    if (literal) {
      tokens.push({ kind: 'string', value: literal.value });
      i = literal.end;
      continue;
    }
    if (c === '(') {
      // A configuration condition: `(dart.library.io)`, `(dart.library.js_interop == 'true')`.
      i = skipGroup(src, i, '(', ')');
      if (i < 0) return null;
      tokens.push({ kind: 'condition' });
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const word = IDENTIFIER.exec(src);
    if (word) {
      tokens.push({ kind: 'word', value: word[0] });
      i += word[0].length;
      continue;
    }
    tokens.push({ kind: 'punctuation', value: c });
    i++;
  }
}

/** A dotted library name (`app.named`), as the words and dots it is written with. */
function dottedName(tokens: readonly DirectiveToken[]): string | null {
  let name = '';
  for (const t of tokens) {
    if (t.kind === 'word' || (t.kind === 'punctuation' && t.value === '.')) name += t.value;
    else return null;
  }
  return name;
}

/** Record the directive `keyword` with `tokens` in `out`; false when the tokens are no such directive. */
function addDirective(out: DartDirectives, keyword: string, tokens: DirectiveToken[]): boolean {
  const first = tokens[0];
  if (keyword === 'library') {
    const name = dottedName(tokens);
    if (name === null) return false;
    out.libraryName = name;
    return true;
  }
  if (keyword === 'part') {
    if (first?.kind === 'word' && first.value === 'of') {
      const target = tokens[1];
      const name = target?.kind === 'string' ? null : dottedName(tokens.slice(1));
      if (target?.kind === 'string') out.partOf = { uri: target.value };
      else if (name) out.partOf = { name };
      else return false;
      return true;
    }
    if (first?.kind !== 'string') return false;
    out.parts.push(first.value);
    return true;
  }
  if (first?.kind !== 'string') return false;
  const uris = [first.value];
  let prefix: string | null = null;
  let filter = EVERY_NAME;
  let k = 1;
  // Adjacent literals are one string: `'package:a/' 'b.dart'`.
  for (let t = tokens[k]; t?.kind === 'string'; t = tokens[++k]) uris[0] += t.value;
  while (k < tokens.length) {
    const t = tokens[k]!;
    const next = tokens[k + 1];
    const uri = tokens[k + 2];
    if (t.kind === 'word' && t.value === 'if' && next?.kind === 'condition' && uri?.kind === 'string') {
      uris.push(uri.value);
      k += 3;
    } else if (t.kind === 'word' && t.value === 'as' && next?.kind === 'word') {
      prefix = next.value;
      k += 2;
    } else if (t.kind === 'word' && (t.value === 'show' || t.value === 'hide')) {
      const names = new Set<string>();
      k++;
      while (tokens[k]?.kind === 'word') {
        names.add((tokens[k] as { value: string }).value);
        const comma = tokens[k + 1];
        if (comma?.kind !== 'punctuation' || comma.value !== ',') {
          k++;
          break;
        }
        k += 2;
      }
      filter = composeFilters(filter, t.value === 'show' ? makeFilter(names, null) : makeFilter(null, names));
    } else {
      // `deferred`, and anything this does not model.
      k++;
    }
  }
  (keyword === 'import' ? out.imports : out.exports).push({ uris, prefix, filter });
  return true;
}

/**
 * The `library`, `part`, `part of`, `import` and `export` directives at the
 * head of a Dart source file — past its script tag, comments and metadata,
 * up to its first declaration.
 */
export function readDartDirectives(source: string): DartDirectives {
  const out: DartDirectives = { libraryName: null, partOf: null, parts: [], imports: [], exports: [] };
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.startsWith('#!', i)) {
    const newline = source.indexOf('\n', i);
    i = newline < 0 ? source.length : newline + 1;
  }
  for (;;) {
    i = skipTrivia(source, i);
    if (i >= source.length) break;
    if (source[i] === '@') {
      i = skipAnnotation(source, i);
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const keyword = IDENTIFIER.exec(source)?.[0];
    if (keyword === undefined || !DIRECTIVE_KEYWORDS.has(keyword)) break;
    const directive = readDirectiveTokens(source, i + keyword.length);
    if (!directive || !addDirective(out, keyword, directive.tokens)) break;
    i = directive.end;
  }
  return out;
}

/** A pub package of the project: its pubspec.yaml's `name`, and the directory holding it ('' for the project root). */
interface PubPackage {
  name: string;
  root: string;
}

/** What a file's imports and its library's own files make visible. */
interface FileScope {
  /** The library's files: the library, its parts, and the file itself. */
  own: ReadonlySet<string>;
  /** The files whose imports apply here: the file, and for a part each file up to its library. */
  importers: readonly string[];
  /** By import prefix ('' for none), the libraries those imports name, each with the import's filter (read on first use). */
  imported: Map<string, Array<{ filter: NameFilter; library: string }>> | null;
  /** By prefix and declaring file, the filters through which the imports bring in its names (read on first use). */
  visible: Map<string, readonly NameFilter[]>;
}

interface Memo {
  directives: Map<string, DartDirectives | null>;
  packageOfDir: Map<string, PubPackage | null>;
  packages: Map<string, PubPackage[]> | null;
  libraryNames: Map<string, string[]> | null;
  libraryOf: Map<string, string | null>;
  /** A part's parent: the file its `part of` names. */
  parentOf: Map<string, string>;
  members: Map<string, ReadonlySet<string>>;
  exports: Map<string, ReadonlyMap<string, readonly NameFilter[]>>;
  scopes: Map<string, FileScope | null>;
}

const memos = new WeakMap<ResolutionContext, Memo>();

function memoFor(context: ResolutionContext): Memo {
  let memo = memos.get(context);
  if (!memo) {
    memo = {
      directives: new Map(),
      packageOfDir: new Map(),
      packages: null,
      libraryNames: null,
      libraryOf: new Map(),
      parentOf: new Map(),
      members: new Map(),
      exports: new Map(),
      scopes: new Map(),
    };
    memos.set(context, memo);
  }
  return memo;
}

/** Drop the memos (see ReferenceResolver.clearCaches). */
export function clearDartLibraryMemos(context: ResolutionContext): void {
  memos.delete(context);
}

function parentDir(file: string): string {
  const cut = file.lastIndexOf('/');
  return cut < 0 ? '' : file.slice(0, cut);
}

function directivesOf(file: string, context: ResolutionContext, memo: Memo): DartDirectives | null {
  const hit = memo.directives.get(file);
  if (hit !== undefined) return hit;
  const source = context.readFile(file);
  const directives = source === null ? null : readDartDirectives(source);
  memo.directives.set(file, directives);
  return directives;
}

const PUBSPEC_NAME = /^name[ \t]*:[ \t]*['"]?([A-Za-z_]\w*)/m;

/** The package of the nearest pubspec.yaml at or above project-relative `dir`, never above the project root. */
function packageOfDir(dir: string, context: ResolutionContext, memo: Memo): PubPackage | null {
  const walked: string[] = [];
  let found: PubPackage | null | undefined;
  for (let d = dir; ; d = parentDir(d)) {
    found = memo.packageOfDir.get(d);
    if (found !== undefined) break;
    walked.push(d);
    const pubspec = d ? `${d}/pubspec.yaml` : 'pubspec.yaml';
    const name = context.fileExists(pubspec) ? PUBSPEC_NAME.exec(context.readFile(pubspec) ?? '')?.[1] : undefined;
    if (name) {
      found = { name, root: d };
      break;
    }
    if (d === '') {
      found = null;
      break;
    }
  }
  for (const d of walked) memo.packageOfDir.set(d, found);
  return found;
}

/** The project's packages named `name`: the packages that hold an indexed .dart file. */
function packagesNamed(name: string, context: ResolutionContext, memo: Memo): readonly PubPackage[] {
  if (!memo.packages) {
    const byName = new Map<string, PubPackage[]>();
    const seen = new Set<PubPackage>();
    for (const file of context.getAllFiles()) {
      if (!file.endsWith('.dart')) continue;
      const pkg = packageOfDir(parentDir(file), context, memo);
      if (!pkg || seen.has(pkg)) continue;
      seen.add(pkg);
      const list = byName.get(pkg.name);
      if (list) list.push(pkg);
      else byName.set(pkg.name, [pkg]);
    }
    memo.packages = byName;
  }
  return memo.packages.get(name) ?? [];
}

/** The project files a URI written in `from` names: none for `dart:` and other schemes, or a package outside the project. */
function resolveDartUri(from: string, uri: string, context: ResolutionContext, memo: Memo): string[] {
  if (uri.startsWith('package:')) {
    const slash = uri.indexOf('/');
    if (slash < 0) return [];
    const name = uri.slice('package:'.length, slash);
    const rest = uri.slice(slash + 1);
    let chosen = packagesNamed(name, context, memo);
    if (chosen.length > 1) {
      const own = packageOfDir(parentDir(from), context, memo);
      const enclosing = chosen.filter((p) => p.root === '' || from.startsWith(`${p.root}/`));
      if (own && own.name === name) chosen = [own];
      else if (enclosing.length > 0) chosen = [enclosing.reduce((a, b) => (b.root.length > a.root.length ? b : a))];
    }
    return chosen.map((p) => path.posix.normalize(p.root ? `${p.root}/lib/${rest}` : `lib/${rest}`));
  }
  if (/^[A-Za-z][\w+.-]*:/.test(uri)) return [];
  const joined = path.posix.normalize(path.posix.join(parentDir(from) || '.', uri));
  return joined === '..' || joined.startsWith('../') || joined.startsWith('/') ? [] : [joined];
}

/** The files declaring `library <name>;`. */
function libraryFilesNamed(name: string, context: ResolutionContext, memo: Memo): readonly string[] {
  if (!memo.libraryNames) {
    const byName = new Map<string, string[]>();
    for (const file of context.getAllFiles()) {
      if (!file.endsWith('.dart') || context.fileContains?.(file, 'library') === false) continue;
      const declared = directivesOf(file, context, memo)?.libraryName;
      if (!declared) continue;
      const list = byName.get(declared);
      if (list) list.push(file);
      else byName.set(declared, [file]);
    }
    memo.libraryNames = byName;
  }
  return memo.libraryNames.get(name) ?? [];
}

/** The file a part's `part of` names, or null when it names none this can find. */
function partParent(file: string, partOf: NonNullable<DartDirectives['partOf']>, context: ResolutionContext, memo: Memo): string | null {
  const candidates = 'uri' in partOf
    ? resolveDartUri(file, partOf.uri, context, memo).filter((f) => directivesOf(f, context, memo) !== null)
    : libraryFilesNamed(partOf.name, context, memo);
  if (candidates.length <= 1) return candidates[0] ?? null;
  const listing = candidates.filter((c) =>
    (directivesOf(c, context, memo)?.parts ?? []).some((uri) => resolveDartUri(c, uri, context, memo).includes(file)));
  return listing.length === 1 ? listing[0]! : null;
}

/** The library file `file` belongs to: itself, or for a part the library its `part of` chain ends at; null when unknown. */
function libraryOf(file: string, context: ResolutionContext, memo: Memo): string | null {
  const hit = memo.libraryOf.get(file);
  if (hit !== undefined) return hit;
  // A part cycle ends at null.
  memo.libraryOf.set(file, null);
  const directives = directivesOf(file, context, memo);
  let library: string | null = null;
  if (directives && !directives.partOf) {
    library = file;
  } else if (directives?.partOf) {
    const parent = partParent(file, directives.partOf, context, memo);
    if (parent !== null) {
      memo.parentOf.set(file, parent);
      library = libraryOf(parent, context, memo);
    }
  }
  memo.libraryOf.set(file, library);
  return library;
}

/** A library's files: the library and its parts, theirs included. */
function membersOf(library: string, context: ResolutionContext, memo: Memo): ReadonlySet<string> {
  const hit = memo.members.get(library);
  if (hit) return hit;
  const files = new Set<string>([library]);
  const queue = [library];
  while (queue.length > 0 && files.size < 1000) {
    const file = queue.shift()!;
    for (const uri of directivesOf(file, context, memo)?.parts ?? []) {
      for (const part of resolveDartUri(file, uri, context, memo)) {
        if (files.has(part)) continue;
        files.add(part);
        queue.push(part);
      }
    }
  }
  memo.members.set(library, files);
  return files;
}

function addFilter(namespace: Map<string, NameFilter[]>, file: string, filter: NameFilter): void {
  const filters = namespace.get(file);
  if (!filters) namespace.set(file, [filter]);
  else if (filters[0] === EVERY_NAME) return;
  else if (filter === EVERY_NAME) filters.splice(0, filters.length, EVERY_NAME);
  else if (!filters.some((f) => f.key === filter.key)) filters.push(filter);
}

/**
 * The files whose public names `library` exports, each with the filters on
 * the way: its own files, and what its `export`s reach. `low` is the
 * shallowest library still on `stack` that the walk came back to; a result
 * that leans on one is incomplete until that library finishes, so it is kept
 * only when the walk came back to nothing shallower than this library.
 */
function exportsOf(
  library: string,
  context: ResolutionContext,
  memo: Memo,
  stack: Map<string, number>,
): { namespace: ReadonlyMap<string, readonly NameFilter[]>; low: number } {
  const hit = memo.exports.get(library);
  if (hit) return { namespace: hit, low: Infinity };
  const depth = stack.size;
  stack.set(library, depth);
  const namespace = new Map<string, NameFilter[]>();
  let low = Infinity;
  const members = membersOf(library, context, memo);
  for (const file of members) addFilter(namespace, file, EVERY_NAME);
  for (const file of members) {
    for (const directive of directivesOf(file, context, memo)?.exports ?? []) {
      for (const uri of directive.uris) {
        for (const target of resolveDartUri(file, uri, context, memo)) {
          const exported = libraryOf(target, context, memo);
          if (exported === null) continue;
          const onStack = stack.get(exported);
          if (onStack !== undefined) {
            low = Math.min(low, onStack);
            continue;
          }
          const inner = exportsOf(exported, context, memo, stack);
          low = Math.min(low, inner.low);
          for (const [f, filters] of inner.namespace) {
            for (const filter of filters) addFilter(namespace, f, composeFilters(directive.filter, filter));
          }
        }
      }
    }
  }
  stack.delete(library);
  if (low >= depth) memo.exports.set(library, namespace);
  return { namespace, low };
}

/**
 * What `file` can see, or null when that is unknown: its library cannot be
 * found, or no pubspec.yaml above it says which package its `package:`
 * imports start from (a mason brick's template, a project indexed below its
 * package root).
 */
function scopeOf(file: string, context: ResolutionContext, memo: Memo): FileScope | null {
  const hit = memo.scopes.get(file);
  if (hit !== undefined) return hit;
  const library = packageOfDir(parentDir(file), context, memo) === null ? null : libraryOf(file, context, memo);
  let scope: FileScope | null = null;
  if (library !== null) {
    const own = new Set(membersOf(library, context, memo));
    own.add(file);
    const importers: string[] = [];
    for (let f: string | undefined = file; f !== undefined && importers.length < 32; f = memo.parentOf.get(f)) {
      importers.push(f);
      if (f === library) break;
    }
    scope = { own, importers, imported: null, visible: new Map() };
  }
  memo.scopes.set(file, scope);
  return scope;
}

/**
 * The filters through which the imports written with `prefix` ('' for none)
 * bring `declFile`'s names in — empty when they bring in none of them — or
 * null when no import has that prefix.
 */
function importedFilters(scope: FileScope, prefix: string, declFile: string, context: ResolutionContext, memo: Memo): readonly NameFilter[] | null {
  if (!scope.imported) {
    scope.imported = new Map();
    for (const importer of scope.importers) {
      for (const directive of directivesOf(importer, context, memo)?.imports ?? []) {
        const key = directive.prefix ?? '';
        const libraries = scope.imported.get(key) ?? [];
        scope.imported.set(key, libraries);
        for (const uri of directive.uris) {
          for (const target of resolveDartUri(importer, uri, context, memo)) {
            const library = libraryOf(target, context, memo);
            if (library !== null) libraries.push({ filter: directive.filter, library });
          }
        }
      }
    }
  }
  const libraries = scope.imported.get(prefix);
  if (!libraries) return prefix === '' ? [] : null;
  const key = `${prefix}\0${declFile}`;
  const hit = scope.visible.get(key);
  if (hit) return hit;
  const through = new Map<string, NameFilter[]>();
  for (const { filter, library } of libraries) {
    for (const exported of exportsOf(library, context, memo, new Map()).namespace.get(declFile) ?? []) {
      addFilter(through, declFile, composeFilters(filter, exported));
    }
  }
  const filters = through.get(declFile) ?? [];
  scope.visible.set(key, filters);
  return filters;
}

/**
 * Whether the library of `fromFile` can name `name`, declared at the top level
 * of `declFile`, without a prefix: `declFile` is one of the library's own
 * files, or a library it imports unprefixed exports the name. True when the
 * library of `fromFile` cannot be established.
 */
export function dartLibrarySees(fromFile: string, declFile: string, name: string, context: ResolutionContext): boolean {
  if (fromFile === declFile) return true;
  const memo = memoFor(context);
  const scope = scopeOf(fromFile, context, memo);
  if (!scope || scope.own.has(declFile)) return true;
  if (name.startsWith('_')) return false;
  return (importedFilters(scope, '', declFile, context, memo) ?? []).some((f) => lets(f, name));
}

/**
 * Whether `prefix.name` in `fromFile` can mean `name` declared at the top
 * level of `declFile`: a library imported `as prefix` exports it. True when
 * no import of the file's library has that prefix, or the library is unknown.
 */
export function dartPrefixSees(fromFile: string, prefix: string, declFile: string, name: string, context: ResolutionContext): boolean {
  const memo = memoFor(context);
  const scope = scopeOf(fromFile, context, memo);
  if (!scope) return true;
  const filters = importedFilters(scope, prefix, declFile, context, memo);
  return filters === null || (!name.startsWith('_') && filters.some((f) => lets(f, name)));
}

/** Whether `declFile` is a file of the library `fromFile` belongs to (false when that library is unknown). */
export function inSameDartLibrary(fromFile: string, declFile: string, context: ResolutionContext): boolean {
  if (fromFile === declFile) return true;
  const scope = scopeOf(fromFile, context, memoFor(context));
  return scope !== null && scope.own.has(declFile);
}

/**
 * Whether `name` is an import prefix where `fromFile` is written: an import
 * of its library is `as name` (`p` in `p.Foo`, not the `Foo` of `Foo.bar`).
 * Where the library is unknown, the file's own imports say.
 */
export function isDartImportPrefix(fromFile: string, name: string, context: ResolutionContext): boolean {
  const memo = memoFor(context);
  const importers = scopeOf(fromFile, context, memo)?.importers ?? [fromFile];
  return importers.some((file) => (directivesOf(file, context, memo)?.imports ?? []).some((d) => d.prefix === name));
}
