/**
 * The modules a repository declares itself, with `declare module 'name' { … }`.
 *
 * In a script declaration file (a `.d.ts` with no top-level `import` or
 * `export`), the statement declares the module outright: cord-field's
 * `typings/mammoth/index.d.ts` is the `mammoth` its code imports, whatever the
 * package ships. TypeScript looks a specifier up among these ambient modules
 * before it resolves the specifier to a file, so `import { MammothOptions }
 * from 'mammoth'` means that declaration. Nothing else maps a package name to
 * a file in the repository: the import resolver follows paths and aliases, and
 * the out-of-repo guard declines every name a file binds from a package its
 * package.json declares.
 *
 * Nothing records which block a member belongs to (#2418 exports a block's
 * declarations without a container node), and one file can declare several
 * modules, so each block is found in the file's text and its members by their
 * position inside it. A wildcard pattern (`declare module '*.svg'`) applies
 * only once a specifier fails to resolve to a file, and a shorthand `declare
 * module 'x';` declares nothing to bind; no import is bound to either.
 */
import type { Node } from '../types';
import type { ResolutionContext, UnresolvedRef } from './types';
import { isTestFile } from '../search/query-utils';

/** One `declare module '<name>' { … }` statement. */
export interface AmbientModuleBlock {
  /** The module's name as written: `mammoth`, `@freiraum/msgreader`. */
  specifier: string;
  /** The `declare` keyword: 1-based line, 0-based column. */
  startLine: number;
  startColumn: number;
  /** The closing brace. */
  endLine: number;
  endColumn: number;
  /** The declaration the module's default export names: `export default X`, `export default class X`, `export = X`. */
  defaultName: string | null;
  /** Names an export clause gives the body's declarations (`export { Impl as Name }`): exported name → local name. */
  exportAliases: Map<string, string>;
  /** A wildcard pattern (`'*.svg'`), which no specifier names exactly. */
  pattern: boolean;
}

export interface AmbientModuleScan {
  /** No top-level `import` or `export`: each block declares its module. In a module file, each block augments one. */
  script: boolean;
  blocks: AmbientModuleBlock[];
}

/** A TypeScript declaration file: `.d.ts`, `.d.mts`, `.d.cts`. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;

/** Whether `file` is a TypeScript declaration file, the kind that declares a module whole. */
export function isDeclarationFile(file: string): boolean {
  return DECLARATION_FILE.test(file);
}

/** Words that start an `export default` declaration rather than name its value. */
const DEFAULT_DECLARATION_WORDS = new Set(['class', 'function', 'interface', 'abstract', 'async', 'enum']);

const enum Kind {
  Word,
  String,
  Template,
  Punct,
}

/**
 * Every `declare module '<name>' { … }` block in `source`, and whether the
 * file is a script.
 *
 * Reads tokens, never a tree: a declaration file holds no code, so strings,
 * template literals and comments are all a brace can hide in. In a module
 * file, a regex literal is read the way a tokenizer guesses one, by what
 * precedes its slash. A block the scan cannot place is left out.
 */
export function scanAmbientModules(source: string): AmbientModuleScan {
  const blocks: AmbientModuleBlock[] = [];
  let script = true;

  // The statement being read at the top level.
  let declare = 0; // 1: `declare`, 2: `declare module`, 3: `declare module '<name>'`
  let declareLine = 0;
  let declareColumn = 0;
  let declareName = '';
  // After a top-level `import`: the tokens seen so far, to tell `import x = N.y`
  // (an alias of a namespace, legal in a script) from every other form.
  let importTokens: Array<{ kind: Kind; text: string }> | null = null;

  // The block being read, and the export statement being read inside it.
  let open: AmbientModuleBlock | null = null;
  let exportState = 0; // 1: `export`, 2: `export default`, 3: `export default class`, 4: `export =`, 5: `export {`
  let clause: string[] = [];

  const settleImport = (): void => {
    const t = importTokens!;
    importTokens = null;
    // `import(…)` and `import.meta` are expressions; `import x = N.y` aliases a namespace.
    if (t[0]?.kind === Kind.Punct && (t[0].text === '(' || t[0].text === '.')) return;
    if (t[0]?.kind === Kind.Word && t[1]?.text === '=' && t[2]?.kind === Kind.Word && t[2].text !== 'require') return;
    script = false;
  };

  const closeClause = (): void => {
    // `export { a, b as c, d as default }`, read as name, name `as` name, separated by commas.
    for (let i = 0; i < clause.length; ) {
      const local = clause[i]!;
      if (clause[i + 1] === 'as' && clause[i + 2] !== undefined) {
        const exported = clause[i + 2]!;
        if (exported === 'default') open!.defaultName ??= local;
        else open!.exportAliases.set(exported, local);
        i += 3;
      } else {
        open!.exportAliases.set(local, local);
        i += 1;
      }
    }
    clause = [];
  };

  const blockToken = (kind: Kind, text: string, depth: number): void => {
    if (exportState === 5) {
      if (kind === Kind.Punct && text === '}' && depth === 1) {
        closeClause();
        exportState = 0;
      } else if (kind === Kind.Word) {
        clause.push(text);
      }
      return;
    }
    if (depth !== 1) return;
    switch (exportState) {
      case 0:
        if (kind === Kind.Word && text === 'export') exportState = 1;
        return;
      case 1:
        if (kind === Kind.Word && text === 'default') exportState = 2;
        else if (kind === Kind.Punct && text === '=') exportState = 4;
        else if (kind === Kind.Punct && text === '{') exportState = 5;
        else exportState = 0;
        return;
      case 2:
        if (kind === Kind.Word && DEFAULT_DECLARATION_WORDS.has(text)) exportState = 3;
        else {
          if (kind === Kind.Word) open!.defaultName ??= text;
          exportState = 0;
        }
        return;
      case 3:
        // `export default abstract class X`, `export default async function X`, `function* X`.
        if ((kind === Kind.Word && DEFAULT_DECLARATION_WORDS.has(text)) || (kind === Kind.Punct && text === '*')) return;
        if (kind === Kind.Word) open!.defaultName ??= text;
        exportState = 0;
        return;
      case 4:
        if (kind === Kind.Word) open!.defaultName ??= text;
        exportState = 0;
        return;
    }
  };

  const token = (kind: Kind, text: string, line: number, column: number, depth: number): void => {
    if (importTokens) {
      importTokens.push({ kind, text });
      // Decided by the first token unless it is a name, then by whether `=` follows, then by what does.
      const t = importTokens;
      if (t.length >= 3 || t[0]!.kind !== Kind.Word || (t.length === 2 && t[1]!.text !== '=')) settleImport();
    }
    if (open) {
      if (kind === Kind.Punct && text === '}' && depth === 0) {
        open.endLine = line;
        open.endColumn = column;
        open.pattern = open.specifier.includes('*');
        blocks.push(open);
        open = null;
        exportState = 0;
        clause = [];
        return;
      }
      blockToken(kind, text, depth);
      return;
    }
    if (depth !== 0) {
      declare = 0;
      return;
    }
    if (kind === Kind.Word) {
      if (text === 'import') {
        importTokens = [];
        declare = 0;
      } else if (text === 'export') {
        script = false;
        declare = 0;
      } else if (text === 'declare') {
        declare = 1;
        declareLine = line;
        declareColumn = column;
      } else {
        declare = declare === 1 && text === 'module' ? 2 : 0;
      }
      return;
    }
    if (kind === Kind.String && declare === 2) {
      declare = 3;
      declareName = text;
      return;
    }
    if (kind === Kind.Punct && text === '{' && declare === 3 && declareName) {
      open = {
        specifier: declareName,
        startLine: declareLine,
        startColumn: declareColumn,
        endLine: 0,
        endColumn: 0,
        defaultName: null,
        exportAliases: new Map(),
        pattern: false,
      };
    }
    declare = 0;
  };

  tokenize(source, token);
  if (importTokens) settleImport();
  return { script, blocks };
}

/** Where a file declares into the global scope. */
export interface GlobalScopeScan {
  /** No top-level `import` or `export`: the file's top level is the global scope. */
  script: boolean;
  /**
   * `line:column` of every word at the global scope: at a script's top level,
   * and directly inside `declare global { … }`. A declaration starts at one of
   * these exactly when it is a global (its keyword: `interface`, `type`, `class`,
   * `abstract`, `enum`, `function`, `const`, …).
   */
  globalWords: Set<string>;
  /** The file's `declare module '<name>' { … }` blocks, whose names are the declared module's. */
  moduleBlocks: readonly AmbientModuleBlock[];
  /** Names an `import X = …` declaration binds: `import AutofillIpcServer = autofill.AutofillIpcServer`. */
  importAliases: Set<string>;
}

/**
 * The global scope's share of `source`: its top level if the file is a
 * script, and the bodies of its `declare global` blocks. A namespace's or a
 * `declare module` block's members, and a module's own declarations, are
 * not in it.
 */
export function scanGlobalScope(source: string): GlobalScopeScan {
  const { script, blocks: moduleBlocks } = scanAmbientModules(source);
  const globalWords = new Set<string>();
  const importAliases = new Set<string>();
  let declare = 0; // 1: `declare`, 2: `declare global`
  let inGlobal = false;
  let alias = 0; // 1: `import` (or `import type`), 2: `import X`
  let aliasName = '';
  tokenize(source, (kind, text, line, column, depth) => {
    if (kind === Kind.Word && text === 'import') alias = 1;
    else if (alias === 1 && kind === Kind.Word && text !== 'type') {
      alias = 2;
      aliasName = text;
    } else if (alias === 2 && kind === Kind.Punct && text === '=') {
      importAliases.add(aliasName);
      alias = 0;
    } else if (!(alias === 1 && kind === Kind.Word)) alias = 0;
    if (inGlobal) {
      if (kind === Kind.Punct && text === '}' && depth === 0) inGlobal = false;
      else if (kind === Kind.Word && depth === 1) globalWords.add(`${line}:${column}`);
      return;
    }
    if (depth !== 0) {
      declare = 0;
      return;
    }
    if (kind === Kind.Word) {
      if (script) globalWords.add(`${line}:${column}`);
      declare = text === 'declare' ? 1 : declare === 1 && text === 'global' ? 2 : 0;
      return;
    }
    if (kind === Kind.Punct && text === '{' && declare === 2) inGlobal = true;
    declare = 0;
  });
  return { script, globalWords, moduleBlocks, importAliases };
}

/** One `namespace A.B { … }` statement, or one in the old spelling, `module A { … }`. */
export interface NamespaceBlock {
  /** The namespace's full name, the namespaces around it first: `A.B` for `namespace B` in `namespace A`, as for `namespace A.B`. */
  path: string;
  /** The `namespace` keyword: 1-based line, 0-based column. */
  startLine: number;
  startColumn: number;
  /** The closing brace. */
  endLine: number;
  endColumn: number;
  /**
   * A global namespace: directly inside `declare global`, at a declaration
   * script's top level, or in another global one. A script `.ts`'s top level
   * is global to its own program only (see isTsTypeInScope in name-matcher).
   */
  global: boolean;
}

/**
 * Every namespace block in `source`, a nested one under its full name. Read
 * from tokens, as the module blocks are. One in a `declare module 'x'` body is
 * module `x`'s, never global, and named as if at the file's top level, where
 * the module's own declarations name it (`const passport:
 * passport.PassportStatic`). One in a class's or a function's body is no
 * namespace a qualified name reaches, and is left out.
 */
export function scanNamespaceBlocks(source: string, declarationFile: boolean): NamespaceBlock[] {
  const topLevelGlobal = declarationFile && scanAmbientModules(source).script;
  const blocks: NamespaceBlock[] = [];
  // What each open brace opened, innermost last.
  const open: Array<NamespaceBlock | 'global' | 'module' | 'other'> = [];
  let names: string[] | null = null; // the names after `namespace`, while its header is read
  let expectName = false;
  let keyword = { line: 0, column: 0 };
  let declare = 0; // 1: `declare`, 2: `declare global`
  let ambientModule = false; // just read `module 'x'`
  let afterDot = false;
  tokenize(source, (kind, text, line, column) => {
    if (kind === Kind.Punct && text === '{') {
      const header = names && names.length > 0 && !expectName ? names : null;
      const outer = open[open.length - 1];
      if (declare === 2) {
        open.push('global');
      } else if (ambientModule) {
        open.push('module');
      } else if (header && outer !== 'other') {
        const parent = typeof outer === 'object' ? outer : null;
        const block: NamespaceBlock = {
          path: (parent ? `${parent.path}.` : '') + header.join('.'),
          startLine: keyword.line,
          startColumn: keyword.column,
          endLine: line,
          endColumn: column,
          global: parent ? parent.global : outer === 'global' || (outer === undefined && topLevelGlobal),
        };
        blocks.push(block);
        open.push(block);
      } else {
        open.push('other');
      }
      names = null;
      declare = 0;
      ambientModule = false;
      afterDot = false;
      return;
    }
    if (kind === Kind.Punct && text === '}') {
      const closed = open.pop();
      if (typeof closed === 'object') {
        closed.endLine = line;
        closed.endColumn = column;
      }
      names = null;
      declare = 0;
      ambientModule = false;
      afterDot = false;
      return;
    }
    ambientModule = names !== null && expectName && names.length === 0 && kind === Kind.String;
    if (names) {
      if (expectName && kind === Kind.Word) {
        names.push(text);
        expectName = false;
        return;
      }
      if (!expectName && kind === Kind.Punct && text === '.') {
        expectName = true;
        return;
      }
      names = null;
    }
    if (kind === Kind.Word) {
      if ((text === 'namespace' || text === 'module') && !afterDot) {
        names = [];
        expectName = true;
        keyword = { line, column };
      }
      declare = text === 'declare' ? 1 : declare === 1 && text === 'global' ? 2 : 0;
      afterDot = false;
      return;
    }
    declare = 0;
    afterDot = kind === Kind.Punct && text === '.';
  });
  return blocks;
}

/**
 * Feed `source`'s tokens to `visit`: words, string literals (by their
 * contents), template literals (as one token, their `${…}` expressions read as
 * code) and punctuation, each with the brace depth outside it — both braces of
 * a block carry the depth the block sits at.
 */
function tokenize(
  source: string,
  visit: (kind: Kind, text: string, line: number, column: number, depth: number) => void
): void {
  const n = source.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0;
  // The brace depth at each open `${`: the `}` that brings depth back to it ends the expression.
  const templates: number[] = [];
  // Whether a `/` here would start a regex: after an operator, a keyword or nothing.
  let regexAllowed = true;

  const newline = (at: number): void => {
    line++;
    lineStart = at + 1;
  };

  // Reads a template literal's text from `i` up to its closing backtick or a `${`.
  const templateText = (): void => {
    while (i < n) {
      const c = source.charCodeAt(i);
      if (c === 92 /* \ */) {
        if (source.charCodeAt(i + 1) === 10) newline(i + 1);
        i += 2;
        continue;
      }
      if (c === 96 /* ` */) {
        i++;
        return;
      }
      if (c === 36 /* $ */ && source.charCodeAt(i + 1) === 123 /* { */) {
        templates.push(depth);
        i += 2;
        return;
      }
      if (c === 10) newline(i);
      i++;
    }
  };

  while (i < n) {
    const c = source.charCodeAt(i);
    if (c === 10) {
      newline(i);
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 13 || c === 0xfeff || c === 0xa0) {
      i++;
      continue;
    }
    const column = i - lineStart;
    if (c === 47 /* / */) {
      const next = source.charCodeAt(i + 1);
      if (next === 47) {
        while (i < n && source.charCodeAt(i) !== 10) i++;
        continue;
      }
      if (next === 42 /* * */) {
        i += 2;
        while (i < n && !(source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47)) {
          if (source.charCodeAt(i) === 10) newline(i);
          i++;
        }
        i += 2;
        continue;
      }
      if (regexAllowed) {
        // A regex literal ends at an unescaped `/` outside a character class, or at the line's end.
        i++;
        let inClass = false;
        while (i < n) {
          const r = source.charCodeAt(i);
          if (r === 10) break;
          if (r === 92) i++;
          else if (r === 91 /* [ */) inClass = true;
          else if (r === 93 /* ] */) inClass = false;
          else if (r === 47 && !inClass) {
            i++;
            break;
          }
          i++;
        }
        while (i < n && isWordChar(source.charCodeAt(i))) i++; // flags
        regexAllowed = false;
        visit(Kind.Template, '', line, column, depth);
        continue;
      }
    }
    if (c === 39 /* ' */ || c === 34 /* " */) {
      let j = i + 1;
      let text = '';
      let from = j;
      while (j < n) {
        const s = source.charCodeAt(j);
        if (s === c || s === 10) break;
        if (s === 92) {
          text += source.slice(from, j);
          j += 2;
          from = j;
          continue;
        }
        j++;
      }
      text += source.slice(from, Math.min(j, n));
      i = j < n && source.charCodeAt(j) === c ? j + 1 : j;
      regexAllowed = false;
      visit(Kind.String, text, line, column, depth);
      continue;
    }
    if (c === 96 /* ` */) {
      i++;
      templateText();
      regexAllowed = false;
      visit(Kind.Template, '', line, column, depth);
      continue;
    }
    if (c === 123 /* { */) {
      visit(Kind.Punct, '{', line, column, depth);
      depth++;
      i++;
      regexAllowed = true;
      continue;
    }
    if (c === 125 /* } */) {
      i++;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        // The end of a template literal's `${…}`: the template's text resumes.
        templates.pop();
        templateText();
        regexAllowed = false;
        continue;
      }
      depth = Math.max(0, depth - 1);
      visit(Kind.Punct, '}', line, column, depth);
      regexAllowed = true;
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(source.charCodeAt(j))) j++;
      const word = source.slice(i, j);
      i = j;
      regexAllowed = REGEX_AFTER_WORDS.has(word);
      visit(Kind.Word, word, line, column, depth);
      continue;
    }
    if (c >= 48 && c <= 57) {
      while (i < n && (isWordChar(source.charCodeAt(i)) || source.charCodeAt(i) === 46)) i++;
      regexAllowed = false;
      continue;
    }
    i++;
    regexAllowed = c !== 41 /* ) */ && c !== 93 /* ] */;
    visit(Kind.Punct, String.fromCharCode(c), line, column, depth);
  }
}

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

function isWordStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
}

function isWordChar(c: number): boolean {
  return isWordStart(c) || (c >= 48 && c <= 57);
}

/** A block of the repository's, in the file that holds it. */
export interface AmbientModule extends AmbientModuleBlock {
  file: string;
  /** Declared in a script: the module itself. Declared in a module file: an augmentation of the package's own. */
  script: boolean;
  /** Declared in a test or a fixture (see declarationsFor). */
  test: boolean;
}

interface Memo {
  /** Every declaration file's blocks, by file and by module name (patterns left out). Built on first use. */
  scanned: { byFile: Map<string, AmbientModule[]>; bySpecifier: Map<string, AmbientModule[]> } | null;
  /** Per block (`file`, line, column): its declarations, by name. */
  members: Map<string, Map<string, Node[]>>;
  /** See ambientModuleDeclarations. */
  declarationIds: ReadonlyMap<string, string> | null;
  /** The blocks of TypeScript files other than declaration files, by file (see isInModuleBlock). */
  otherBlocks: Map<string, readonly AmbientModuleBlock[]>;
  /** declarationsFor's answers, by specifier and importing file. */
  declarations: Map<string, AmbientModule[]>;
  /** isMergedAmbientDeclaration's answers, by node id. */
  merged: Map<string, boolean>;
  /** Each read file's namespace blocks (see namespaceBlocks). */
  namespaces: Map<string, readonly NamespaceBlock[]>;
}

const MEMO = new WeakMap<ResolutionContext, Memo>();

/** Drop the per-context index (see ReferenceResolver.clearCaches): files and nodes may have changed. */
export function clearAmbientModuleMemos(context: ResolutionContext): void {
  MEMO.delete(context);
}

function memoFor(context: ResolutionContext): Memo {
  let memo = MEMO.get(context);
  if (!memo) MEMO.set(context, (memo = { scanned: null, members: new Map(), declarationIds: null, otherBlocks: new Map(), declarations: new Map(), merged: new Map(), namespaces: new Map() }));
  return memo;
}

/** The namespace blocks of `file` (scanNamespaceBlocks), read once a resolution pass. */
export function namespaceBlocks(file: string, context: ResolutionContext): readonly NamespaceBlock[] {
  const memo = memoFor(context);
  let blocks = memo.namespaces.get(file);
  if (!blocks) {
    const source = context.readFile(file);
    blocks = source && /\b(?:namespace|module)\s+[A-Za-z_$]/.test(source) ? scanNamespaceBlocks(source, DECLARATION_FILE.test(file)) : [];
    memo.namespaces.set(file, blocks);
  }
  return blocks;
}

/**
 * The `declare module` blocks of the project's declaration files. Only those
 * are read: a module is declared whole in a `.d.ts`, and reading every
 * TypeScript file for the rare one written elsewhere would cost each
 * resolution pass a read of the whole project.
 */
function scanned(context: ResolutionContext): NonNullable<Memo['scanned']> {
  const memo = memoFor(context);
  if (memo.scanned) return memo.scanned;
  const byFile = new Map<string, AmbientModule[]>();
  const bySpecifier = new Map<string, AmbientModule[]>();
  for (const file of [...context.getAllFiles()].sort()) {
    if (!DECLARATION_FILE.test(file)) continue;
    if (context.fileContains && !context.fileContains(file, 'declare')) continue;
    const source = context.readFile(file);
    if (!source || !/\bdeclare\s+module\s*['"]/.test(source)) continue;
    const scan = scanAmbientModules(source);
    const test = isTestCode(file);
    const modules = scan.blocks.map((block): AmbientModule => ({ ...block, file, script: scan.script, test }));
    if (modules.length === 0) continue;
    byFile.set(file, modules);
    for (const mod of modules) {
      if (mod.pattern) continue;
      const list = bySpecifier.get(mod.specifier);
      if (list) list.push(mod);
      else bySpecifier.set(mod.specifier, [mod]);
    }
  }
  memo.scanned = { byFile, bySpecifier };
  return memo.scanned;
}

/** Kinds a statement in a module body declares. */
const DECLARATION_KINDS = new Set<Node['kind']>(['function', 'class', 'interface', 'type_alias', 'enum', 'constant', 'variable', 'component']);

/** Whether `node` starts inside the block, by position. */
export function inBlock(
  node: Pick<Node, 'startLine' | 'startColumn'>,
  block: Pick<AmbientModuleBlock, 'startLine' | 'startColumn' | 'endLine' | 'endColumn'>
): boolean {
  const afterStart = node.startLine > block.startLine || (node.startLine === block.startLine && node.startColumn >= block.startColumn);
  const beforeEnd = node.startLine < block.endLine || (node.startLine === block.endLine && node.startColumn <= block.endColumn);
  return afterStart && beforeEnd;
}

/** Whether `node` is a declaration at a block's own level: not a class's or an interface's member. */
function isBlockLevel(node: Node): boolean {
  return DECLARATION_KINDS.has(node.kind) && node.qualifiedName === node.name;
}

/** The declarations at the block's own level, by name, in position order. */
function blockMembers(mod: AmbientModule, context: ResolutionContext): Map<string, Node[]> {
  const memo = memoFor(context);
  const key = `${mod.file}\0${mod.startLine}\0${mod.startColumn}`;
  const cached = memo.members.get(key);
  if (cached) return cached;
  const members = new Map<string, Node[]>();
  const nodes = context
    .getNodesInFile(mod.file)
    .filter((n) => isBlockLevel(n) && inBlock(n, mod))
    .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn);
  for (const n of nodes) {
    const list = members.get(n.name);
    if (list) list.push(n);
    else members.set(n.name, [n]);
  }
  memo.members.set(key, members);
  return members;
}

/** A path that is not the program's own: a test, a fixture, an example (see search/query-utils). */
const isTestCode = (file: string): boolean => isTestFile(file);

/**
 * The script declarations of `specifier` an import in `fromFile` can mean,
 * the files nearest it first. One a test or a fixture keeps counts only for a
 * test's imports: copies of vscode's API typings under copilot's
 * `test/fixtures` are left out of its build and shadow nothing.
 */
function declarationsFor(specifier: string, fromFile: string, context: ResolutionContext): AmbientModule[] {
  const all = scanned(context).bySpecifier.get(specifier);
  if (!all) return [];
  const memo = memoFor(context);
  const key = `${specifier}\0${fromFile}`;
  const cached = memo.declarations.get(key);
  if (cached) return cached;
  const fromTest = isTestCode(fromFile);
  const dir = fromFile.slice(0, fromFile.lastIndexOf('/') + 1);
  const usable = all.filter((m) => m.script && (fromTest || !m.test));
  const from = dir.split('/');
  const shared = (file: string): number => {
    const parts = file.split('/');
    let k = 0;
    while (k < from.length - 1 && k < parts.length - 1 && from[k] === parts[k]) k++;
    return k;
  };
  const ordered = usable.length < 2 ? usable : usable
    .map((m, index) => ({ m, index, near: shared(m.file) }))
    .sort((a, b) => Number(a.m.test) - Number(b.m.test) || b.near - a.near || a.index - b.index)
    .map((x) => x.m);
  memo.declarations.set(key, ordered);
  return ordered;
}

/** The kinds a reference of `refKind` is most likely to mean, first. */
function kindRank(refKind: UnresolvedRef['referenceKind'], kind: Node['kind']): number {
  const callable = kind === 'function' || kind === 'class' || kind === 'constant' || kind === 'variable' || kind === 'component';
  const type = kind === 'interface' || kind === 'class' || kind === 'type_alias' || kind === 'enum';
  switch (refKind) {
    case 'calls':
    case 'function_ref':
      return callable ? 0 : 1;
    case 'instantiates':
      return kind === 'class' ? 0 : callable ? 1 : 2;
    case 'extends':
    case 'implements':
      return kind === 'class' || kind === 'interface' ? 0 : 1;
    case 'references':
      return type ? 0 : 1;
    default:
      return 0;
  }
}

/**
 * The declaration an import of `want` from the package `specifier` means,
 * through the repository's own `declare module 'specifier'`, or undefined.
 *
 * A named import is a declaration the body exports, or one an export clause
 * names. A default import is what the body's `export default` or `export =`
 * names. A namespace import's member is a declaration exported under the
 * member's name. Same-named declarations (an interface and the value merged
 * with it, a function's overloads) give the one the reference's kind means,
 * then the first.
 */
export function findAmbientModuleExport(
  specifier: string,
  want: { isDefault: boolean; isNamespace: boolean; exportedName: string; memberName: string | null },
  ref: UnresolvedRef,
  context: ResolutionContext
): Node | undefined {
  if (want.isNamespace && (!want.memberName || want.memberName.includes('.'))) return undefined;
  for (const mod of declarationsFor(specifier, ref.filePath, context)) {
    const members = blockMembers(mod, context);
    let found: Node[] | undefined;
    if (want.isDefault) {
      found = mod.defaultName ? members.get(mod.defaultName) : undefined;
    } else {
      const name = want.isNamespace ? want.memberName! : want.exportedName;
      const local = mod.exportAliases.get(name);
      // Under an export clause the clause decides; otherwise what the body exports.
      found = local !== undefined ? members.get(local) : members.get(name)?.filter((n) => n.isExported);
    }
    if (found && found.length > 0) {
      return [...found].sort((a, b) => kindRank(ref.referenceKind, a.kind) - kindRank(ref.referenceKind, b.kind))[0];
    }
  }
  return undefined;
}

/**
 * The file node of the declaration file that declares the module `specifier`
 * (a script's `declare module`), nearest `fromFile`: what a namespace or
 * default import of the package depends on. Undefined when none does.
 */
export function findAmbientModuleFile(specifier: string, fromFile: string, context: ResolutionContext): Node | undefined {
  const [mod] = declarationsFor(specifier, fromFile, context);
  if (!mod || mod.file === fromFile) return undefined;
  return context.getNodesInFile(mod.file).find((n) => n.kind === 'file');
}

/** Whether the repository declares `specifier` itself, and its declaration exports `name` (or the default). */
export function ambientModuleDeclares(specifier: string, name: string, isDefault: boolean, ref: UnresolvedRef, context: ResolutionContext): boolean {
  return findAmbientModuleExport(specifier, { isDefault, isNamespace: false, exportedName: name, memberName: null }, ref, context) !== undefined;
}

/** The `declare module` block of a declaration file whose own level declares `node`, if any. */
function blockDeclaring(node: Node, context: ResolutionContext): AmbientModule | undefined {
  if (!isBlockLevel(node) || !DECLARATION_FILE.test(node.filePath)) return undefined;
  return scanned(context).byFile.get(node.filePath)?.find((mod) => inBlock(node, mod));
}

/**
 * The declarations at the own level of declaration files' `declare module 'x'`
 * bodies, by id, each with the `x` its block declares. A module's members are
 * never global: a bare `encode()` elsewhere is no call of the `encode`
 * excalidraw declares for `png-chunks-encode`, Node's `import * as fs from
 * 'fs'` no import of the `fs` vscode's `workspace` namespace declares, and an
 * ESLint `Property` no use of emmet's `declare module 'EmmetFlatNode'`. A
 * map, so asking about every reference a strategy other than the import
 * resolver settles costs a lookup (see reachesAmbientModule).
 */
export function ambientModuleDeclarations(context: ResolutionContext): ReadonlyMap<string, string> {
  const memo = memoFor(context);
  if (memo.declarationIds) return memo.declarationIds;
  const ids = new Map<string, string>();
  for (const [file, modules] of scanned(context).byFile) {
    for (const node of context.getNodesInFile(file)) {
      if (!isBlockLevel(node)) continue;
      const mod = modules.find((m) => inBlock(node, m));
      if (mod) ids.set(node.id, mod.specifier);
    }
  }
  memo.declarationIds = ids;
  return ids;
}

/**
 * Whether line:column of `file` lies inside a block declaring `specifier`:
 * one of the module's own declarations, which merge, as vscode's proposed API
 * files add to `vscode.d.ts`'s `declare module 'vscode'`. A declaration
 * file's blocks are the scanned ones; another TypeScript file's are read the
 * first time one is asked about.
 */
export function isInModuleBlock(file: string, line: number, column: number, specifier: string, context: ResolutionContext): boolean {
  let blocks: readonly AmbientModuleBlock[] | undefined = scanned(context).byFile.get(file);
  if (!blocks && !DECLARATION_FILE.test(file)) {
    const memo = memoFor(context);
    blocks = memo.otherBlocks.get(file);
    if (!blocks) {
      const source = context.readFile(file);
      blocks = source && /\bdeclare\s+module\s*['"]/.test(source) ? scanAmbientModules(source).blocks : [];
      memo.otherBlocks.set(file, blocks);
    }
  }
  return (blocks ?? []).some((block) => block.specifier === specifier && inBlock({ startLine: line, startColumn: column }, block));
}

/**
 * Whether `node` is one of several declarations of the same name that the
 * blocks declaring one module merge: vscode declares `InlineCompletionItemProvider`
 * in `vscode.d.ts`, and the proposed API files declaring `vscode` add members
 * to it. No one of them holds every member, so none answers which method a
 * value of the type calls.
 */
export function isMergedAmbientDeclaration(node: Node, context: ResolutionContext): boolean {
  const memo = memoFor(context);
  const cached = memo.merged.get(node.id);
  if (cached !== undefined) return cached;
  const mod = blockDeclaring(node, context);
  let merged = false;
  if (mod && !mod.pattern) {
    let count = 0;
    for (const other of scanned(context).bySpecifier.get(mod.specifier) ?? []) {
      count += blockMembers(other, context).get(node.name)?.length ?? 0;
      if (count > 1) {
        merged = true;
        break;
      }
    }
  }
  memo.merged.set(node.id, merged);
  return merged;
}
