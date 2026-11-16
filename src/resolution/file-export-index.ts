/**
 * File export index cache and utilities for CommonJS export resolution.
 *
 * This module provides the FileExportIndex type and cache for resolving
 * CommonJS module exports. It is separated from import-resolver.ts to avoid
 * circular imports, since name-matcher.ts needs to query it to determine whether
 * a module is an "imported module receiver".
 */
import type { Node } from '../types';
import type { ResolutionContext } from './types';
import { makeLineAt } from './synth-utils';
import { stripCommentsForRegex, templateLiteralTextAt } from './strip-comments';

/**
 * What a file's own `export default` statement exports: the node it declares
 * or names, `'anonymous'` for a function or class with no name (no node
 * stands for it), `'unstated'` when the file says nothing a node answers.
 */
export type StatedDefault = Node | 'anonymous' | 'unstated';

export interface FileExportIndex {
  /** Exported declarations by name. Read through {@link exportedByName}. */
  byName: Map<string, Node>;
  defaultComponent: Node | undefined;
  defaultFnClass: Node | undefined;
  /**
   * What the file's own `export default` statement exports — the precise
   * answer where `defaultComponent`/`defaultFnClass` are guesses. `undefined`
   * until first read through {@link statedDefaultExport}.
   */
  statedDefault?: StatedDefault;
  /** What `module.exports =` says, once read (see commonJsDefaultExport). */
  commonJsDefault?: { source?: string; name?: string } | null;
  /**
   * Names a local export clause (`export { impl as alias }`) binds to a
   * declaration the extractor never flagged isExported, for names not in
   * `byName`. `undefined` until first read through {@link exportedByName}.
   */
  clauseAliases?: Map<string, Node>;
  /**
   * Exported members of something else in the file (`export const d = { f()
   * {} }` → `d::f`) by name: no import's first answer, only its last, after
   * the file's own bindings, export clause and re-exports (#2945). That last
   * answer is what reaches `d.f` through `export const { f } = d`, whose
   * binding has no node of its own.
   */
  members: Map<string, Node>;
}

/** Cache of export indexes, per resolution context. */
const fileExportIndexes = new WeakMap<ResolutionContext, Map<string, FileExportIndex>>();

/** Drop the per-context file export index cache (see ReferenceResolver.clearCaches). */
export function clearFileExportIndexes(context: ResolutionContext): void {
  fileExportIndexes.delete(context);
}

/**
 * `module.exports = …` (also `exports = module.exports = …`): the name it
 * binds (`createApplication`, `function name(`, `class Name`) or the module
 * it forwards (`require('./lib/express')`), or null.
 */
const COMMONJS_DEFAULT_EXPORT =
  /^[ \t]*(?:exports\s*=\s*)?module\.exports\s*=\s*(?:exports\s*=\s*)?(?:require\(\s*['"]([^'"]+)['"]\s*\)\s*;?[ \t]*$|(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|class\s+([A-Za-z_$][\w$]*)|new\s+([A-Za-z_$][\w$]*)\s*\(|([A-Za-z_$][\w$]*)\s*;?[ \t]*$)/m;

const JS_FAMILY_FILE = /\.(?:[cm]?[jt]sx?)$/;

const PYTHON_MODULE_FILE = /\.py$/;

const PYTHON_MODULE_LEVEL_KINDS = new Set<string>(['function', 'class', 'variable', 'constant']);

/** A def at module level — what `from mod import name` can bind. */
function isPythonModuleLevelDef(n: Node): boolean {
  return PYTHON_MODULE_LEVEL_KINDS.has(n.kind) && !n.qualifiedName.includes('::');
}

export function getFileExportIndex(filePath: string, context: ResolutionContext): FileExportIndex {
  let perFile = fileExportIndexes.get(context);
  if (!perFile) {
    perFile = new Map();
    fileExportIndexes.set(context, perFile);
  }
  let idx = perFile.get(filePath);
  if (!idx) {
    idx = { byName: new Map(), defaultComponent: undefined, defaultFnClass: undefined, members: new Map() };
    // Python has no export keyword: every module-level def is importable, and
    // the extractor never flags one isExported. Without this a Python named
    // import could only ever resolve through the bare-name matcher.
    const exported = PYTHON_MODULE_FILE.test(filePath)
      ? context.getNodesInFile(filePath).filter((n) => n.isExported || isPythonModuleLevelDef(n))
      : context.getExportedNodesInFile?.(filePath) ?? context.getNodesInFile(filePath).filter((n) => n.isExported);
    const jsFamily = JS_FAMILY_FILE.test(filePath);
    for (const n of exported) {
      if (jsFamily && n.qualifiedName !== n.name) {
        if (!idx.members.has(n.name)) idx.members.set(n.name, n);
        continue;
      }
      if (!idx.byName.has(n.name)) idx.byName.set(n.name, n);
      if (idx.defaultComponent === undefined && n.kind === 'component') idx.defaultComponent = n;
      if (idx.defaultFnClass === undefined && (n.kind === 'function' || n.kind === 'class')) idx.defaultFnClass = n;
    }
    perFile.set(filePath, idx);
  }
  return idx;
}

export function commonJsDefaultExport(filePath: string, context: ResolutionContext): { source?: string; name?: string } | null {
  if (!JS_FAMILY_FILE.test(filePath)) return null;
  if (context.fileContains && !context.fileContains(filePath, 'module.exports')) return null;
  const idx = getFileExportIndex(filePath, context);
  if (idx.commonJsDefault !== undefined) return idx.commonJsDefault;
  const source = context.readFile(filePath);
  const m = source && source.includes('module.exports') ? COMMONJS_DEFAULT_EXPORT.exec(source) : null;
  idx.commonJsDefault = !m ? null : m[1] ? { source: m[1] } : { name: m[2] ?? m[3] ?? m[4] ?? m[5] };
  return idx.commonJsDefault;
}

export const DEFAULT_BINDING_KINDS = new Set<string>(['function', 'class', 'component', 'constant', 'variable']);
const DEFAULT_DECLARATION_KINDS = new Set<string>(['function', 'class', 'component']);

const EXPORT_DEFAULT_HEAD = /^[ \t]*export\s+default\s+/gm;
/** `[async] function[*] [NAME]` / `[abstract] class [NAME]`; the name is group 1 or 2. */
const DEFAULT_DECLARATION_RE =
  /^(?:async\s+)?function\b\s*(?:\*\s*)?([A-Za-z_$][\w$]*)?|^(?:abstract\s+)?class\b(?:\s+(?!extends\b|implements\b)([A-Za-z_$][\w$]*))?/;
/** `[async] x =>`, or `[async] (` opening what may be an arrow function's parameters. */
const DEFAULT_ARROW_RE = /^(?:async\s+)?(?:[A-Za-z_$][\w$]*\s*=>|\()/;
/** `NAME` alone on its line. */
const DEFAULT_BINDING_RE = /^([A-Za-z_$][\w$]*)\s*;?[ \t]*(?:\r?\n|$)/;

/**
 * The value of the `export default` statement whose value starts at `at`, in
 * comment-stripped code: the name a declaration or a binding gives it,
 * the class a `new` expression constructs (`new ApiClient()` -> `ApiClient`),
 * `'anonymous'` for a function, class or arrow function without one, or null
 * for any other expression.
 */
function readDefaultExport(code: string, at: number): { name: string; nameAt: number; declared: boolean } | 'anonymous' | null {
  const rest = code.slice(at, at + 2048);
  const decl = DEFAULT_DECLARATION_RE.exec(rest);
  if (decl) {
    const name = decl[1] ?? decl[2];
    return name ? { name, nameAt: at + decl[0].length - name.length, declared: true } : 'anonymous';
  }
  const arrow = DEFAULT_ARROW_RE.exec(rest);
  if (arrow) {
    if (!arrow[0].endsWith('(')) return 'anonymous';
    // A parenthesized list is an arrow function's parameters when `=>` or a
    // return type (`(…): JSX.Element =>`) follows it; otherwise it is an
    // expression (`(Foo)`).
    let depth = 0;
    for (let i = arrow[0].length - 1; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')' && --depth === 0) return /^\s*(?:=>|:)/.test(rest.slice(i + 1)) ? 'anonymous' : null;
    }
    return null;
  }
  const constructed = /^new\s+([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
  if (constructed) {
    const name = constructed[1]!;
    return { name, nameAt: at + constructed[0].indexOf(name), declared: false };
  }
  const binding = DEFAULT_BINDING_RE.exec(rest);
  return binding ? { name: binding[1]!, nameAt: at, declared: false } : null;
}

/**
 * What `filePath`'s own `export default` statement exports. The statement
 * says it outright, where the export index can only guess:
 * - `export default function Vans() {…}` / `export default class Store` —
 *   the declaration the statement writes, found by position. A React Router
 *   data-router page exports its `loader` or `action` above it, and the
 *   first-exported guess bound the page's default import to the loader.
 * - `export default Home` — the binding it names, exported at its
 *   declaration or not: `const Home = () => …` and the namespace object
 *   `const UploadApi = { uploadARCapture }` have no `export_statement`
 *   ancestor, so the `isExported` index never sees them.
 * - `export default new ApiClient()` — the class the instance is of, found
 *   by name (#3272).
 * - `export default function () {…}`, `export default class {…}`, `export
 *   default () => …` — anonymous: no node is the default export, and any
 *   exported function beside it (or nested in it, which the extractor flags
 *   exported too) would be the wrong one.
 * Anything else — an expression (`memo(Card)`, `{ … }`), a
 * binding the file doesn't declare, no statement at all, a non-JS file — is
 * `'unstated'`. Comments are stripped first. Strings are not masked: a
 * template whose `${…}` holds another template, or a regex with a backtick,
 * sets a masker out of step, and it blanked the real statement after it
 * (outline's 2,900-line styled-components `Styles.ts`). A statement must
 * name a node of the file instead, and of several statements, one that does
 * wins. A line of a template's text is no statement either, though it can
 * name one: a code generator's `export default App` names the file's own
 * `App` (#2968). So a head inside template text is skipped, when a scan that
 * follows `${…}` nesting and regex literals closes every template; one that
 * doesn't vouches for nothing, and every head counts.
 */
export function statedDefaultExport(filePath: string, idx: FileExportIndex, context: ResolutionContext): StatedDefault {
  if (idx.statedDefault !== undefined) return idx.statedDefault;
  let stated: StatedDefault | undefined;
  const source = JS_FAMILY_FILE.test(filePath) ? context.readFile(filePath) : null;
  if (source && /\bexport\s+default\b/.test(source)) {
    const code = stripCommentsForRegex(source, 'typescript');
    const lineAt = makeLineAt(code, 1);
    const inTemplateText = templateLiteralTextAt(source);
    EXPORT_DEFAULT_HEAD.lastIndex = 0;
    for (let m = EXPORT_DEFAULT_HEAD.exec(code); m !== null; m = EXPORT_DEFAULT_HEAD.exec(code)) {
      if (inTemplateText?.(m.index)) continue;
      const value = readDefaultExport(code, m.index + m[0].length);
      if (value === 'anonymous') {
        stated ??= 'anonymous';
        continue;
      }
      stated ??= 'unstated';
      if (value === null) continue;
      const named = nodesInFileNamed(filePath, value.name, context);
      // A declaration starts on the statement's line, or on its name's when
      // the statement breaks before it (`export default\nfunction X`).
      const from = lineAt(m.index);
      const to = lineAt(value.nameAt);
      const node = value.declared
        ? named.find((n) => DEFAULT_DECLARATION_KINDS.has(n.kind) && n.startLine >= from && n.startLine <= to)
        : moduleBindingsFirst(filePath, named
            .filter((n) => DEFAULT_BINDING_KINDS.has(n.kind))
            .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn))[0];
      if (node) {
        stated = node;
        break;
      }
    }
  }
  idx.statedDefault = stated ?? 'unstated';
  return idx.statedDefault;
}

/**
 * `nodes` with the members of something else in their JS/TS file (an
 * object's method `d::f`) moved behind the module's own bindings. Extraction
 * marks such a member exported, so it can share a name with what an import,
 * export clause or default export means (#2945); it stays the last answer
 * because `const { f } = d` gives the binding `f` no node but `d::f`.
 */
export function moduleBindingsFirst(filePath: string, nodes: Node[]): Node[] {
  if (!JS_FAMILY_FILE.test(filePath)) return nodes;
  const own = nodes.filter((n) => n.qualifiedName === n.name);
  return own.length === nodes.length ? nodes : [...own, ...nodes.filter((n) => n.qualifiedName !== n.name)];
}

/** The file's nodes named `name`, in `getNodesInFile` order. */
export function nodesInFileNamed(filePath: string, name: string, context: ResolutionContext): Node[] {
  return context.getNodesInFileNamed?.(filePath, name) ?? context.getNodesInFile(filePath).filter((n) => n.name === name);
}
/**
 * Whether the member `memberName` belongs to the value the file default-exports:
 * the class an `export default new X()` / `export default X` statement names, or
 * the class/function a `module.exports =` statement names (including `new X()`).
 * A call through a default import of such a module is legitimate, so the
 * imported-module guard must not block it (#3272).
 */
export function defaultExportValueHasMember(filePath: string, memberName: string, context: ResolutionContext): boolean {
  const idx = getFileExportIndex(filePath, context);
  const stated = statedDefaultExport(filePath, idx, context);
  if (typeof stated === 'object' && valueHasMember(stated, memberName, context)) return true;
  const commonJs = commonJsDefaultExport(filePath, context);
  if (commonJs?.name) {
    const decl = nodesInFileNamed(filePath, commonJs.name, context).find(
      (n) => n.kind === 'class' || n.kind === 'function',
    );
    if (decl && valueHasMember(decl, memberName, context)) return true;
  }
  return false;
}

/** Whether `node` (a class or function) has a method named `memberName`. */
function valueHasMember(node: Node, memberName: string, context: ResolutionContext): boolean {
  return context
    .getNodesInFile(node.filePath)
    .some((n) => n.kind === 'method' && n.qualifiedName === `${node.qualifiedName}::${memberName}`);
}
