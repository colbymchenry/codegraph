/** Conservative Cargo/module identity for source-derived FFI dispatch.
 * A unique short type name is never evidence of a cross-crate binding.
 * Supported external bindings require a local path dependency (including a
 * workspace-inherited path dependency) and declared, indexed Rust modules.
 * A file belongs to its nearest package, and `crate::` names the root of the
 * library or binary target whose module tree declares that file.
 */
import * as path from 'node:path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getParser } from '../extraction/grammars';
import { parseWithinBudget } from '../extraction/parse-budget';
import type { ResolutionContext } from './types';
import type { RustOwnerResolver } from './rust-ffi-analysis';

interface Package { dir: string; manifest: string; name?: string; lib?: string; bins: string[] }
interface Module { file: string; inline: string[] }
interface Decl { name: string; inline: boolean; customPath: boolean }
interface Table { name: string; array: boolean; entries: Map<string, string> }
const normal = (s: string): string => path.posix.normalize(s).replace(/^\.\//, '');
const safe = (s: string): boolean => !path.posix.isAbsolute(s) && s !== '..' && !s.startsWith('../');

// Deliberately small TOML subset. Unknown/escaped/multiline values do not
// become guessed paths; duplicate keys are rejected. `[[name]]` starts one
// entry of an array of tables, never a continuation of the previous table.
function tables(source: string): Table[] {
  const out: Table[] = [{ name: '', array: false, entries: new Map() }];
  for (const line of source.split(/\r?\n/)) {
    const header = /^\s*(\[\[?)([^[\]]+)(\]\]?)\s*(?:#.*)?$/.exec(line);
    if (header) {
      const array = header[1] === '[[';
      out.push({ name: array === (header[3] === ']]') ? header[2]!.trim() : '\0invalid', array, entries: new Map() });
      continue;
    }
    const entry = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (entry) { const entries = out.at(-1)!.entries; entries.set(entry[1]!, entries.has(entry[1]!) ? '' : entry[2]!); }
  }
  return out;
}
function stringValue(raw: string | undefined): string | undefined {
  return raw && /^(["'])([^"'\\\r\n]*)\1\s*(?:#.*)?$/.exec(raw)?.[2] || undefined;
}
function inlineString(raw: string, key: string): string | undefined {
  // No nested tables; quoted strings cannot inject fields into this parser.
  const match = /^\{([^{}]*)\}\s*(?:#.*)?$/.exec(raw);
  if (!match) return undefined;
  const fields = match[1]!.match(/(?:[A-Za-z0-9_-]+)\s*=\s*(?:"[^"\\]*"|'[^'\\]*'|true|false)\s*(?:,|$)/g);
  if (!fields || fields.join('').replace(/\s/g, '') !== match[1]!.replace(/\s/g, '')) return undefined;
  const values = fields.filter(f => new RegExp(`^\\s*${key}\\s*=`).test(f));
  return values.length === 1 ? stringValue(values[0]!.replace(/^\s*\w+\s*=\s*/, '').replace(/,\s*$/, '')) : undefined;
}

export function createRustBridgeIdentity(ctx: ResolutionContext): RustOwnerResolver {
  const parsedManifests = new Map<string, Table[]>();
  const table = (manifest: string, name: string): Map<string, string> => {
    let parsed = parsedManifests.get(manifest);
    if (!parsed) parsedManifests.set(manifest, parsed = tables(manifest));
    return parsed.find(t => !t.array && t.name === name)?.entries ?? new Map();
  };
  const arrayEntries = (manifest: string, name: string): Array<Map<string, string>> => {
    let parsed = parsedManifests.get(manifest);
    if (!parsed) parsedManifests.set(manifest, parsed = tables(manifest));
    return parsed.filter(t => t.array && t.name === name).map(t => t.entries);
  };
  let allFiles: string[] | undefined;
  const roots = new Set<string>();
  const packages = new Map<string, Package | null | undefined>();
  /** undefined: no manifest here; null: a manifest without a usable package (e.g. a virtual workspace). */
  const readPackage = (dir: string): Package | null | undefined => {
    if (packages.has(dir)) return packages.get(dir);
    const manifest = ctx.readFile(normal(path.posix.join(dir, 'Cargo.toml')));
    let value: Package | null | undefined;
    if (manifest === null) value = undefined;
    else if (!table(manifest, 'package').size) value = null;
    else {
      const existing = (relative: string | undefined): string | undefined => {
        if (relative === undefined) return undefined;
        const file = normal(path.posix.join(dir, relative));
        return safe(file) && ctx.fileExists(file) ? file : undefined;
      };
      const lib = table(manifest, 'lib');
      // A configured but unreadable path is never replaced by the default.
      const libRoot = lib.has('path') ? existing(stringValue(lib.get('path'))) : existing('src/lib.rs');
      const prefix = dir === '.' ? '' : `${dir}/`;
      allFiles ??= ctx.getAllFiles?.() ?? [];
      const discovered = allFiles.filter(file => file.startsWith(`${prefix}src/bin/`) &&
        /^src\/bin\/(?:[^/]+\.rs|[^/]+\/main\.rs)$/.test(file.slice(prefix.length)));
      const bins = [...new Set([existing('src/main.rs'), ...arrayEntries(manifest, 'bin').map(bin => existing(stringValue(bin.get('path')))), ...discovered]
        .filter((file): file is string => file !== undefined))];
      const name = (stringValue(lib.get('name')) ?? stringValue(table(manifest, 'package').get('name')))?.replace(/-/g, '_');
      value = { dir, manifest, name, ...(libRoot ? { lib: libRoot } : {}), bins };
      for (const root of [libRoot, ...bins]) if (root) roots.add(root);
    }
    packages.set(dir, value);
    return value;
  };
  const nearest = (file: string): Package | null => {
    let dir = path.posix.dirname(file);
    while (safe(dir)) {
      // The first manifest decides; an enclosing package never adopts a nested crate's files.
      const found = readPackage(dir);
      if (found !== undefined) return found;
      if (dir === '.') break;
      dir = path.posix.dirname(dir);
    }
    return null;
  };
  const modules = new Map<string, Map<string, Decl[]> | null>();
  const declarations = (file: string): Map<string, Decl[]> | null => {
    if (modules.has(file)) return modules.get(file)!;
    const source = ctx.readFile(file);
    const parser = getParser('rust');
    const tree = source !== null && parser ? parseWithinBudget(parser, source) : null;
    if (!tree) { modules.set(file, null); return null; }
    const out = new Map<string, Decl[]>();
    const scan = (node: SyntaxNode, scope: string[]): void => {
      for (const child of node.namedChildren) {
        if (child?.type !== 'mod_item') continue;
        const name = child.childForFieldName('name')?.text;
        if (!name) continue;
        const body = child.childForFieldName('body');
        let sibling = child.previousNamedSibling;
        let customPath = false;
        while (sibling && (sibling.type === 'attribute_item' || sibling.type.endsWith('comment'))) {
          if (sibling.type === 'attribute_item' && /\bpath\s*=/.test(sibling.text)) customPath = true;
          sibling = sibling.previousNamedSibling;
        }
        const key = scope.join('::');
        const list = out.get(key) ?? [];
        list.push({ name, inline: !!body, customPath }); out.set(key, list);
        if (body) scan(body, [...scope, name]);
      }
    };
    try { scan(tree.rootNode, []); } finally { tree.delete(); }
    modules.set(file, out); return out;
  };
  const descend = (start: Module, parts: string[]): Module | null => {
    let current = start;
    for (const name of parts) {
      if (!/^\w+$/.test(name)) return null;
      const matches = declarations(current.file)?.get(current.inline.join('::'))?.filter(d => d.name === name) ?? [];
      if (matches.length !== 1 || matches[0]!.customPath) return null;
      if (matches[0]!.inline) { current = { ...current, inline: [...current.inline, name] }; continue; }
      // A crate root and a mod.rs own their directory; any other file owns a directory named after it.
      const owner = roots.has(current.file) || path.posix.basename(current.file) === 'mod.rs';
      const dir = owner ? path.posix.dirname(current.file) : current.file.replace(/\.rs$/, '');
      const stem = normal(path.posix.join(dir, ...current.inline, name));
      const choices = [`${stem}.rs`, `${stem}/mod.rs`].filter(f => ctx.fileExists(f));
      if (choices.length !== 1) return null;
      current = { file: choices[0]!, inline: [] };
    }
    return current;
  };
  const reachableFiles = new Map<string, Set<string>>();
  const isDeclaredFile = (root: string, file: string): boolean => {
    let files = reachableFiles.get(root);
    if (!files) {
      files = new Set();
      const seen = new Set<string>();
      const queue: Module[] = [{ file: root, inline: [] }];
      for (let i = 0; i < queue.length; i++) {
        const current = queue[i]!;
        const key = `${current.file}#${current.inline.join('::')}`;
        if (seen.has(key)) continue;
        seen.add(key); files.add(current.file);
        for (const decl of declarations(current.file)?.get(current.inline.join('::')) ?? []) {
          const next = descend(current, [decl.name]);
          if (next) queue.push(next);
        }
      }
      reachableFiles.set(root, files);
    }
    return files.has(file);
  };
  /** The one target root whose module tree declares `file`; a file compiled into several targets has none. */
  const targetRoot = (pkg: Package, file: string): string | undefined => {
    const owners = [pkg.lib, ...pkg.bins].filter((root): root is string => !!root && isDeclaredFile(root, file));
    return owners.length === 1 ? owners[0] : undefined;
  };
  const dependency = (pkg: Package, name: string): Package | null => {
    const entries = [...table(pkg.manifest, 'dependencies')].filter(([key]) => key.replace(/-/g, '_') === name);
    let dependencyPath: string | undefined;
    let baseDir = pkg.dir;
    if (entries.length === 1) {
      const [key, raw] = entries[0]!;
      dependencyPath = inlineString(raw, 'path');
      if (!dependencyPath && /^\{\s*workspace\s*=\s*true\s*\}\s*(?:#.*)?$/.test(raw)) {
        let dir = pkg.dir;
        while (safe(dir)) {
          const manifest = ctx.readFile(normal(path.posix.join(dir, 'Cargo.toml')));
          const inherited = manifest && table(manifest, 'workspace.dependencies').get(key);
          if (inherited) { dependencyPath = inlineString(inherited, 'path'); baseDir = dir; break; }
          if (dir === '.') break;
          dir = path.posix.dirname(dir);
        }
      }
    } else if (entries.length === 0) {
      dependencyPath = stringValue(table(pkg.manifest, `dependencies.${name}`).get('path'));
    }
    if (!dependencyPath) return null;
    const dir = normal(path.posix.join(baseDir, dependencyPath));
    return safe(dir) ? readPackage(dir) ?? null : null;
  };
  return (ownerPath, caller, candidates) => {
    const parts = ownerPath.split('::').filter(Boolean);
    const leaf = parts.pop();
    if (!leaf || parts.length === 0) return undefined;
    const pkg = nearest(caller.filePath);
    if (!pkg) return undefined;
    const own = targetRoot(pkg, caller.filePath);
    let root = own;
    let start: Module = { file: caller.filePath, inline: caller.modulePath.split('::').filter(Boolean) };
    let relativeTarget: Module | null = null;
    const first = parts[0];
    if (first === 'crate') {
      if (!own) return undefined;
      parts.shift(); start = { file: own, inline: [] };
    } else if (first === pkg.name && pkg.lib) {
      // A binary names its own package's library by the crate name.
      parts.shift(); root = pkg.lib; start = { file: pkg.lib, inline: [] };
    } else if (first === 'self') parts.shift();
    else if (first === 'super') return undefined; // requires parent-module ancestry, deliberately not guessed
    else {
      relativeTarget = ownerPath.startsWith('::') ? null : descend(start, parts);
      if (!relativeTarget) {
        const dep = dependency(pkg, parts.shift()!);
        if (!dep?.lib) return undefined;
        root = dep.lib;
        start = { file: dep.lib, inline: [] };
      }
    }
    const target = relativeTarget ?? descend(start, parts);
    if (!target) return undefined;
    const macros = candidates.filter(fn => fn.isMacro && fn.macroExport && fn.name === leaf && !!root &&
      target.file === root && target.inline.length === 0 && isDeclaredFile(root, fn.filePath));
    if (macros.length) return macros.length === 1 ? macros[0] : undefined;
    const matches = candidates.filter(fn => !fn.isMacro && fn.filePath === target.file &&
      fn.modulePath.split('::').filter(Boolean).join('::') === target.inline.join('::') &&
      (fn.owner === leaf || (!fn.owner && fn.name === leaf)));
    return matches.length === 1 ? matches[0] : undefined;
  };
}
