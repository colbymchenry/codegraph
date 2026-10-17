/**
 * OCaml / dune Resolver
 *
 * dune compiles a library's modules under a wrapper named after the library:
 * module `Entry` of `(library (name noema))` is used from outside as
 * `Noema.Entry`. The extractor names every file's module after the file, so a
 * call `Noema.Entry.run` reaches the index as `Noema::Entry::run` while the
 * function is qualified `Entry::run`. This resolver reads the `dune` files of
 * the project, learns each wrapped library's name and directory, and resolves
 * such a call by dropping the wrapper segment.
 *
 * `(wrapped false)` libraries have no wrapper and need nothing.
 */

import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

type Sexp = string | Sexp[];

/** Read dune's s-expressions: atoms, "strings", `;` / `#| |#` / `#;` comments. */
function parseSexps(text: string): Sexp[] {
  let i = 0;
  const readList = (): Sexp[] => {
    const items: Sexp[] = [];
    while (i < text.length) {
      const ch = text.charAt(i);
      if (/\s/.test(ch)) i++;
      else if (ch === ';') while (i < text.length && text.charAt(i) !== '\n') i++;
      else if (text.startsWith('#|', i)) {
        const end = text.indexOf('|#', i + 2);
        i = end < 0 ? text.length : end + 2;
      } else if (text.startsWith('#;', i)) {
        i += 2;
        readOne(); // datum comment: drop the next expression
      } else if (ch === ')') {
        i++;
        return items;
      } else {
        const item = readOne();
        if (item !== null) items.push(item);
      }
    }
    return items;
  };
  const readOne = (): Sexp | null => {
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
    const ch = text.charAt(i);
    if (ch === '(') {
      i++;
      return readList();
    }
    if (ch === '"') {
      let s = '';
      for (i++; i < text.length && text.charAt(i) !== '"'; i++) {
        if (text.charAt(i) === '\\') i++;
        s += text.charAt(i);
      }
      i++;
      return s;
    }
    const start = i;
    while (i < text.length && !/[\s()";]/.test(text.charAt(i))) i++;
    return i > start ? text.slice(start, i) : null;
  };
  return readList();
}

/** The fields of a stanza: `(library (name x) (wrapped false))` → `name` → ['x'], `wrapped` → ['false']. */
function field(stanza: Sexp[], key: string): Sexp[] | null {
  for (const item of stanza) {
    if (Array.isArray(item) && item[0] === key) return item.slice(1);
  }
  return null;
}

export interface DuneLibrary {
  /** Wrapper module name: `(name noema)` → `Noema`. */
  wrapper: string;
  /** Project-relative directory of the `dune` file ('' for the root). */
  dir: string;
}

/** The wrapped libraries declared by the project's `dune` files, keyed by wrapper module name. */
export function getDuneLibraries(context: ResolutionContext): Map<string, DuneLibrary[]> {
  const libs = new Map<string, DuneLibrary[]>();
  // A `dune` file sits in a directory above some .ml/.mli file; probing those
  // directories finds them all without walking the tree (dune files are not indexed).
  const dirs = new Set<string>();
  for (const file of context.getAllFiles()) {
    if (!/\.mli?$/.test(file)) continue;
    for (let dir = file.slice(0, Math.max(file.lastIndexOf('/'), 0)); ; dir = dir.slice(0, dir.lastIndexOf('/'))) {
      if (dirs.has(dir)) break;
      dirs.add(dir);
      if (!dir.includes('/')) {
        dirs.add('');
        break;
      }
    }
  }
  for (const dir of dirs) {
    const text = context.readFile(dir ? `${dir}/dune` : 'dune');
    if (!text) continue;
    for (const stanza of parseSexps(text)) {
      if (!Array.isArray(stanza) || stanza[0] !== 'library') continue;
      const name = field(stanza, 'name')?.[0];
      if (typeof name !== 'string' || field(stanza, 'wrapped')?.[0] === 'false') continue;
      const wrapper = name.charAt(0).toUpperCase() + name.slice(1);
      libs.set(wrapper, [...(libs.get(wrapper) ?? []), { wrapper, dir }]);
    }
  }
  return libs;
}

const libraryCache = new WeakMap<ResolutionContext, Map<string, DuneLibrary[]>>();

function libraries(context: ResolutionContext): Map<string, DuneLibrary[]> {
  let libs = libraryCache.get(context);
  if (!libs) libraryCache.set(context, (libs = getDuneLibraries(context)));
  return libs;
}

export const ocamlResolver: FrameworkResolver = {
  name: 'ocaml',
  languages: ['ocaml', 'ocaml_interface'],

  detect(context: ResolutionContext): boolean {
    return context.fileExists('dune-project');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const segments = ref.referenceName.split('::');
    const owners = segments.length > 1 ? libraries(context).get(segments[0]!) : undefined;
    if (!owners) return null;
    const inLibrary = (filePath: string): boolean =>
      owners.some((lib) => !lib.dir || filePath.startsWith(`${lib.dir}/`));
    const found = context
      .getNodesByQualifiedName(segments.slice(1).join('::'))
      .filter((n) => (n.language === 'ocaml' || n.language === 'ocaml_interface') && inLibrary(n.filePath));
    // A `val` in the `.mli` and its `let` in the `.ml` share a qualified name; calls go to the implementation.
    const targets = found.some((n) => n.language === 'ocaml') ? found.filter((n) => n.language === 'ocaml') : found;
    if (targets.length !== 1) return null; // none, or ambiguous: stay unresolved
    return { original: ref, targetNodeId: targets[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
  },
};
