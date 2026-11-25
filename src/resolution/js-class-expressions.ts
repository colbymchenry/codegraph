/**
 * A named class expression's name is bound inside the expression alone
 * (#2499): `register(class Gadget {…})` declares no `Gadget` for the code
 * around it, where `new Gadget()` throws a ReferenceError. The extractor gives
 * such a class a node, so its members are its own and its `extends` is
 * known, and marks it with its head as its signature (`class Gadget`), which
 * a class declaration doesn't carry.
 *
 * The class's name is bound nowhere outside the expression, and its value
 * travels in ways resolution doesn't follow, except an import of what a
 * module exports. So the resolver reads a reference outside the class
 * expressions without their classes and members (ReferenceResolver's
 * classExpressionFreeContextFor): there the reference means what it meant
 * before those classes were indexed. A binding of the same name around an
 * expression, like the `Panel` of `const Panel = class Panel {…}`, keeps the
 * name, at the confidence it had. A class a CommonJS module exports,
 * `module.exports = class Router {…}`, is the module's value, which every
 * importer binds, so it isn't scoped: it is read as a declaration is.
 */
import type { Node } from '../types';
import type { UnresolvedRef } from './types';

/** Languages a class expression's class and the references to its name can be written in: TS/JS, and the scripts of Vue, Svelte and Astro files. */
export const CLASS_EXPRESSION_REF_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'arkts', 'vue', 'svelte', 'astro']);

/** What the resolver knows of the classes named class expressions declare (ReferenceResolver.classExpressions). */
export interface ClassExpressionIndex {
  /** The classes, by name. */
  byName: Map<string, Node[]>;
  /** The classes, by the file that holds them. */
  byFile: Map<string, Node[]>;
  /** The files that hold them. */
  files: Set<string>;
  /** The ids of the classes and of their members. */
  hiddenIds: Set<string>;
  /** The class a member belongs to, when it is one of them. */
  ownerOf: (member: Node) => Node | undefined;
}

/** Whether `node` is a class a named class expression declares. */
export function isJsClassExpression(node: Node): boolean {
  return node.kind === 'class' && !!node.signature && CLASS_EXPRESSION_REF_LANGUAGES.has(node.language);
}

/** The end of the text before a class a CommonJS module exports: `module.exports = `, `exports.Router = `, `module.exports.Router = `. */
const COMMONJS_EXPORT_BEFORE = /(?:^|[^\w$.])(?:module\.)?exports(?:\.[A-Za-z_$][\w$]*)?\s*=\s*$/;

/**
 * Whether a class expression is what its CommonJS module exports, as in
 * `module.exports = class Router {…}` or `exports.Router = class Router {…}`
 * (`lines`: its file's lines). An importer reaches that class, its statics
 * and, through an instance, its methods, as it reaches a declaration's.
 */
export function isCommonJsExportedClass(node: Node, lines: readonly string[]): boolean {
  const line = lines[node.startLine - 1];
  if (line === undefined) return false;
  return COMMONJS_EXPORT_BEFORE.test(`${lines[node.startLine - 2] ?? ''}\n${line.slice(0, node.startColumn)}`);
}

/** Whether the reference is written inside `node`'s source range. */
export function writtenIn(node: Node, ref: UnresolvedRef): boolean {
  if (node.filePath !== ref.filePath) return false;
  const afterStart = ref.line > node.startLine || (ref.line === node.startLine && ref.column >= node.startColumn);
  const beforeEnd = ref.line < node.endLine || (ref.line === node.endLine && ref.column <= node.endColumn);
  return afterStart && beforeEnd;
}
