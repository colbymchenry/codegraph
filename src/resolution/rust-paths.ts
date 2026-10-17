/**
 * Rust path resolution.
 *
 * Maps a Rust path — `crate::m::Item`, `super::f`, `self::sub::Item`, a bare
 * `sub::Item`, and a path into ANOTHER crate of the project
 * (`sim::items::ItemPool::for_def`) — to the node it names, by walking the
 * module tree on disk (`<seg>.rs` / `<seg>/mod.rs`) from the path's anchor:
 *
 * - `crate` / `self` / `super` — the current crate root / module / parent module;
 * - a project crate's name — a workspace member, or any in-project `path`
 *   dependency by the key its dependents write — anchors at that crate's
 *   library root (see `getCargoWorkspaceCrateMap`);
 * - a name the file binds with `use` (`use sim::items::ItemPool;` makes
 *   `ItemPool::for_def` mean `sim::items::ItemPool::for_def`).
 *
 * What remains after the module segments is an item of the last module
 * (`Item`), or an associated item of a type (`Type::member`). A name the
 * module does not define itself is followed through its `pub use`
 * re-exports (`pub use rng::Rng;`, `pub use prelude::*;`).
 */

import * as path from 'path';
import { Node } from '../types';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { cargoCrateSourceDir, getCargoWorkspaceCrateMap } from './frameworks/cargo-workspace';
import { stripCommentsForRegex } from './strip-comments';

/** A file's `use` declarations: each bound name's full path, and each glob's module path. */
interface RustUseTree {
  bindings: Map<string, string>;
  globs: string[];
}

/** Path anchors that never name a crate, a module or a `use` binding. */
const RUST_PATH_KEYWORDS = new Set(['crate', 'self', 'super', 'Self']);
/** How many re-export / `use` hops one path may take (a cycle stops here too). */
const MAX_RUST_PATH_HOPS = 4;
/** Kinds a module-level Rust item is extracted as (`pub const`/`static` are `variable`). */
const RUST_ITEM_KINDS: ReadonlySet<string> = new Set([
  'function', 'struct', 'union', 'enum', 'trait', 'type_alias', 'constant', 'variable', 'class', 'interface',
]);
/** Kinds an associated item (`Type::member`) is extracted as. */
const RUST_MEMBER_KINDS: ReadonlySet<string> = new Set([
  'method', 'function', 'enum_member', 'constant', 'variable', 'type_alias', 'property', 'field',
]);

const RUST_FILE_USES = new WeakMap<ResolutionContext, Map<string, RustUseTree>>();
const RUST_CRATE_SOURCES = new WeakMap<ResolutionContext, Map<string, string>>();

/** Drop the per-context memos (see clearImportResolverMemos). */
export function clearRustPathMemos(context: ResolutionContext): void {
  RUST_FILE_USES.delete(context);
  RUST_CRATE_SOURCES.delete(context);
}

/**
 * Rust `use` declarations: each bound name flattened to its full path, and
 * each glob (`use a::b::*`) to its module path. Handles nested groups
 * (`use a::{b::C, d as E}`) and `as` aliases.
 */
function parseRustUseTree(content: string): RustUseTree {
  const bindings = new Map<string, string>();
  const globs: string[] = [];

  // Expand one level of `{...}` at a time so `a::{b::{C, D}, E}` flattens.
  const expand = (spec: string): string[] => {
    const open = spec.indexOf('{');
    if (open === -1) return [spec.trim()];
    const prefix = spec.slice(0, open);
    let depth = 0;
    let close = -1;
    for (let i = open; i < spec.length; i++) {
      if (spec[i] === '{') depth++;
      else if (spec[i] === '}') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close === -1) return [];
    const suffix = spec.slice(close + 1);
    const inner = spec.slice(open + 1, close);
    const parts: string[] = [];
    let depth2 = 0;
    let start = 0;
    for (let i = 0; i <= inner.length; i++) {
      const ch = inner[i];
      if (ch === '{') depth2++;
      else if (ch === '}') depth2--;
      if (i === inner.length || (ch === ',' && depth2 === 0)) {
        const seg = inner.slice(start, i).trim();
        if (seg) parts.push(seg);
        start = i + 1;
      }
    }
    return parts.flatMap((p) => expand(prefix + p + suffix));
  };

  // `use` items end at the first `;`. Attributes/visibility (`pub use`) are
  // irrelevant to the binding itself.
  const useRe = /(^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(content)) !== null) {
    for (const spec of expand(m[2]!.replace(/\s+/g, ' '))) {
      const aliasMatch = /^(.*?)\s+as\s+([A-Za-z_]\w*)$/.exec(spec);
      const rawPath = (aliasMatch ? aliasMatch[1]! : spec).trim();
      if (!rawPath) continue;
      const segments = rawPath.split('::').map((s) => s.trim()).filter(Boolean);
      if (segments[segments.length - 1] === '*') {
        if (segments.length > 1) globs.push(segments.slice(0, -1).join('::'));
        continue;
      }
      // `use a::b::{self, C}` binds `b` itself.
      if (segments[segments.length - 1] === 'self') segments.pop();
      const leaf = segments[segments.length - 1];
      if (!leaf) continue;
      const local = aliasMatch ? aliasMatch[2]! : leaf;
      bindings.set(local, segments.join('::'));
    }
  }
  return { bindings, globs };
}

/**
 * Rust `use` declarations, flattened to `localName → full path`. Rust is the
 * one supported language with NO `ImportMapping` extraction, so this is the
 * only channel that can tell what a name in a Rust file was brought in by.
 */
export function collectRustUseBindings(content: string): Map<string, string> {
  return parseRustUseTree(content).bindings;
}

/** The `use` tree of an indexed file, comments stripped, memoized per context. */
function rustUsesInFile(filePath: string, context: ResolutionContext): RustUseTree {
  let memo = RUST_FILE_USES.get(context);
  if (!memo) {
    memo = new Map();
    RUST_FILE_USES.set(context, memo);
  }
  let uses = memo.get(filePath);
  if (!uses) {
    uses = parseRustUseTree(stripCommentsForRegex(context.readFile(filePath) ?? '', 'rust'));
    memo.set(filePath, uses);
  }
  return uses;
}

/**
 * Each project crate's name, as code writes it (`my_crate`), to the
 * project-relative directory of its library root: workspace members, in-project
 * `path` dependencies, and the root package itself.
 */
function rustCrateSources(context: ResolutionContext): Map<string, string> {
  const hit = RUST_CRATE_SOURCES.get(context);
  if (hit) return hit;
  const sources = new Map<string, string>();
  for (const [name, dir] of getCargoWorkspaceCrateMap(context)) {
    const ident = name.replace(/-/g, '_');
    if (!sources.has(ident)) sources.set(ident, cargoCrateSourceDir(dir, context));
  }
  const rootName = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(context.readFile('Cargo.toml') ?? '')?.[1];
  if (rootName && !sources.has(rootName.replace(/-/g, '_'))) {
    sources.set(rootName.replace(/-/g, '_'), cargoCrateSourceDir('', context));
  }
  RUST_CRATE_SOURCES.set(context, sources);
  return sources;
}

/** The crate-root directory (holds `lib.rs`/`main.rs`), walking up from a file. */
function rustCrateRootDir(fromFileAbs: string, context: ResolutionContext): string | null {
  const projectRoot = context.getProjectRoot();
  const toRel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, '/');
  let dir = path.dirname(fromFileAbs);
  for (let i = 0; i < 64; i++) {
    if (context.fileExists(toRel(path.join(dir, 'lib.rs'))) ||
        context.fileExists(toRel(path.join(dir, 'main.rs')))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Directory under which the current file's module declares its SUBMODULES. */
function rustSelfModuleDir(fromFileAbs: string): string {
  const base = path.basename(fromFileAbs);
  const dir = path.dirname(fromFileAbs);
  // mod.rs / lib.rs / main.rs own their directory; `foo.rs`'s submodules live in `foo/`.
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
  return path.join(dir, base.replace(/\.rs$/, ''));
}

/** Where a module path got to: the last module's file, and how many segments named modules. */
interface RustModuleAt {
  file: string;
  consumed: number;
}

/**
 * Every reading of a path's leading MODULE segments, most specific anchor
 * first: each names the file of the deepest module reached and how many
 * segments it consumed. A bare path is tried as a submodule of the current
 * module (2018), as a project crate's name, then crate-relative (2015).
 */
function rustModuleAnchors(segments: string[], fromFile: string, context: ResolutionContext): RustModuleAt[] {
  if (segments.length === 0) return [];
  const projectRoot = context.getProjectRoot();
  const fromAbs = path.join(projectRoot, fromFile);
  const toRel = (p: string) => path.relative(projectRoot, p).replace(/\\/g, '/');
  const existing = (abs: string): string | null => {
    const rel = toRel(abs);
    return context.fileExists(rel) ? rel : null;
  };
  // The file of the module that owns directory `dir`: `dir.rs`, `dir/mod.rs`, or a crate root.
  const moduleFileOf = (dir: string): string | null =>
    existing(dir + '.rs') ?? existing(path.join(dir, 'mod.rs')) ??
    existing(path.join(dir, 'lib.rs')) ?? existing(path.join(dir, 'main.rs'));
  // Consume module segments down from `dir` while `<seg>.rs` / `<seg>/mod.rs` exists.
  const descend = (dir: string, file: string, consumed: number): RustModuleAt => {
    while (consumed < segments.length) {
      const seg = segments[consumed]!;
      const next = existing(path.join(dir, seg + '.rs')) ?? existing(path.join(dir, seg, 'mod.rs'));
      if (!next) break;
      file = next;
      dir = path.join(dir, seg);
      consumed++;
    }
    return { file, consumed };
  };

  const first = segments[0]!;
  if (first === 'crate') {
    const root = rustCrateRootDir(fromAbs, context);
    const file = root ? moduleFileOf(root) : null;
    return root && file ? [descend(root, file, 1)] : [];
  }
  if (first === 'self') return [descend(rustSelfModuleDir(fromAbs), fromFile, 1)];
  if (first === 'super') {
    let supers = 0;
    while (segments[supers] === 'super') supers++;
    let dir = rustSelfModuleDir(fromAbs);
    for (let s = 0; s < supers; s++) dir = path.dirname(dir);
    const file = moduleFileOf(dir);
    return file ? [descend(dir, file, supers)] : [];
  }

  const anchors: RustModuleAt[] = [];
  const selfRelative = descend(rustSelfModuleDir(fromAbs), fromFile, 0);
  if (selfRelative.consumed > 0) anchors.push(selfRelative);
  const crateSrc = rustCrateSources(context).get(first);
  if (crateSrc !== undefined) {
    const dir = path.join(projectRoot, crateSrc);
    const file = existing(path.join(dir, 'lib.rs')) ?? existing(path.join(dir, 'main.rs'));
    if (file) anchors.push(descend(dir, file, 1));
  }
  const root = rustCrateRootDir(fromAbs, context);
  if (root) {
    const file = moduleFileOf(root);
    const crateRelative = file ? descend(root, file, 0) : null;
    if (crateRelative && crateRelative.consumed > 0) anchors.push(crateRelative);
  }
  return anchors;
}

/**
 * Resolve a Rust module path (segments WITHOUT the leaf symbol) to the file of
 * the last module segment — `crate::a::b` → `<crate>/a/b.rs` (or `.../b/mod.rs`),
 * `sim::items` → `crates/sim/src/items.rs`. Null unless every segment is a module.
 */
export function resolveRustModuleFile(
  segments: string[],
  fromFile: string,
  context: ResolutionContext
): string | null {
  return rustModuleAnchors(segments, fromFile, context).find((at) => at.consumed === segments.length)?.file ?? null;
}

/** A module-level item `name` of `file`, defined there or re-exported by one of its `use`s. */
function findRustItem(file: string, name: string, context: ResolutionContext, hops: number): Node | null {
  const named = context.getNodesInFileNamed?.(file, name) ?? context.getNodesInFile(file).filter((n) => n.name === name);
  const own = named.find((n) => RUST_ITEM_KINDS.has(n.kind) && n.qualifiedName === name);
  if (own) return own;
  if (hops >= MAX_RUST_PATH_HOPS) return null;
  const uses = rustUsesInFile(file, context);
  const reexport = uses.bindings.get(name);
  if (reexport) {
    const target = resolveRustPath(reexport.split('::'), file, context, hops + 1);
    if (target) return target;
  }
  for (const glob of uses.globs) {
    const target = resolveRustPath([...glob.split('::'), name], file, context, hops + 1);
    if (target) return target;
  }
  return null;
}

/**
 * An associated item `Type::member`: in the type's own file first, else in an
 * `impl` elsewhere in the same crate.
 */
function findRustMember(owner: Node, member: string, context: ResolutionContext): Node | null {
  const qualified = `${owner.name}::${member}`;
  const isMember = (n: Node) => RUST_MEMBER_KINDS.has(n.kind) && n.qualifiedName === qualified;
  const local = context.getNodesInFile(owner.filePath).find(isMember);
  if (local) return local;
  const projectRoot = context.getProjectRoot();
  const crateRoot = rustCrateRootDir(path.join(projectRoot, owner.filePath), context);
  const crateDir = crateRoot === null ? null : path.relative(projectRoot, crateRoot).replace(/\\/g, '/');
  const inCrate = (n: Node) => crateDir === null || crateDir === '' || n.filePath.startsWith(`${crateDir}/`);
  const elsewhere = context.getNodesByQualifiedName(qualified)
    .filter((n) => n.language === 'rust' && isMember(n) && inCrate(n));
  return elsewhere.length === 1 ? elsewhere[0]! : null;
}

/** The node a Rust path names, read from `fromFile`; null when it isn't the project's. */
function resolveRustPath(segments: string[], fromFile: string, context: ResolutionContext, hops: number): Node | null {
  if (segments.length < 2) return null;
  const first = segments[0]!;
  // A name the file binds with `use` means what the `use` names.
  if (!RUST_PATH_KEYWORDS.has(first) && hops < MAX_RUST_PATH_HOPS) {
    const bound = rustUsesInFile(fromFile, context).bindings.get(first);
    if (bound && bound !== first) {
      const target = resolveRustPath([...bound.split('::'), ...segments.slice(1)], fromFile, context, hops + 1);
      if (target) return target;
    }
  }
  for (const at of rustModuleAnchors(segments, fromFile, context)) {
    const rest = segments.slice(at.consumed);
    if (rest.length === 0 || rest.length > 2) continue;
    const item = findRustItem(at.file, rest[0]!, context, hops);
    if (!item) continue;
    if (rest.length === 1) return item;
    const member = findRustMember(item, rest[1]!, context);
    if (member) return member;
  }
  return null;
}

/**
 * The `a::b` written directly before a reference's leaf (`scheduler` for
 * `&scheduler::Handle`), or null when it is written bare or its position
 * can't be read back from the source.
 */
function rustWrittenQualifier(ref: UnresolvedRef, context: ResolutionContext): string[] | null {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  const line = lines?.[ref.line - 1];
  if (line === undefined || !line.startsWith(ref.referenceName, ref.column)) return null;
  // Comments are blanked (offset-preserving) over the lines read back, so a
  // `// crate::scheduler::` note above the leaf is not taken as its qualifier.
  const first = Math.max(0, ref.line - 4);
  const window = [...lines!.slice(first, ref.line - 1), line.slice(0, ref.column)];
  const stripped = stripCommentsForRegex(window.join('\n'), 'rust').split('\n');
  let before = stripped[stripped.length - 1]!;
  // `scheduler::\n    Handle`: the leaf starts its line, the qualifier ends the previous one.
  for (let i = stripped.length - 2; i >= 0 && before.trim() === ''; i--) {
    before = stripped[i]! + before;
  }
  const qualified = /((?:[A-Za-z_]\w*\s*::\s*)+)$/.exec(before);
  if (!qualified) return null;
  return qualified[1]!.split('::').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Resolve a Rust reference written as a path (`crate::m::Item`,
 * `sim::items::ItemPool::for_def`, `super::f`), or a bare name the file binds
 * with a `use` (`roll_item` under `use sim::items::roll_item;`), to the node
 * it names. This is the precise answer for common-name items that name
 * matching can't disambiguate — `pub use self::read::read` re-exports, and the
 * same type and method names in two crates of one workspace. Returns null
 * when the path isn't the project's (`serde::de::Error`, `std::mem::take`),
 * so external paths, associated functions of local variables, and the rest
 * fall through untouched. Paths that land in the referencing file itself are
 * left to the name matcher.
 */
export function resolveRustPathReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  let segments = ref.referenceName.split('::').filter((s) => s.length > 0);
  if (segments.length === 1) {
    // The extractor keeps only the leaf of `&scheduler::Handle`; the source says
    // whether it was written through a path. A path resolves by its own
    // segments — a file-level `use …::Handle` is a different `Handle`.
    const qualifier = rustWrittenQualifier(ref, context);
    if (qualifier) {
      segments = [...qualifier, segments[0]!];
    } else {
      const bound = rustUsesInFile(ref.filePath, context).bindings.get(segments[0]!);
      if (!bound) return null;
      segments = bound.split('::');
    }
  }
  const target = resolveRustPath(segments, ref.filePath, context, 0);
  if (!target || target.filePath === ref.filePath) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'import' };
}
