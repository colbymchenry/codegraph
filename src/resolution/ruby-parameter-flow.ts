/**
 * Ruby's side of a parameter's class from its call sites (./parameter-flow).
 *
 * Ruby writes no types, so all of it is read from source: a `def`'s parameters
 * (its node carries no signature), the arguments at a call, and the few shapes
 * of value that say their class exactly.
 */

import * as path from 'path';
import type { Node } from '../types';
import type { Abstention, FlowMethod, FlowParameter, FlowSignature, FlowSite, FlowValue, FollowParameter, ParameterFlowAdapter, ParameterFlowLanguage } from './parameter-flow';
import { MAX_SOURCE_FILE_SIZE_BYTES, readSourceText } from '../file-limits';
import { rubyAncestry, rubyClassMethodOf, rubyConstantQn, rubyMethodsOf } from './name-matcher';
import { ivarClass } from './ruby-constant-paths';
import { createYielder } from './cooperative-yield';

/** The arguments of one call, as written. */
interface RubyArguments {
  positional: string[];
  keywords: Map<string, string>;
  /** Where the first `*splat` is among `positional`, past which nothing's place is known; -1 for none. */
  splatAt: number;
  keywordSplat: boolean;
}

interface RubySignature extends FlowSignature {
  /** Names a call fills with several values, or with none it writes. */
  gathering: Set<string>;
  /** What of the method follows the parameters on their last line. */
  rest: string;
  /** Whether a call with these arguments can be a call of this method. */
  accepts(args: RubyArguments): boolean;
}

/** What a stretch of source binds. */
interface Bindings {
  /** Each `name = value` and `name ||= value` written as a statement. */
  assigned: Map<string, string[]>;
  /** Names bound any other way: a block's or a lambda's parameter, `rescue … =>`, a pattern, several assignment, an operator. */
  other: Set<string>;
}

/** Line starts while a file is read. A file within the size limit has a line per byte at most. */
let scratch: Int32Array | null = null;

/**
 * A file's lines, from offsets into its text: a pass reads a project's worth of
 * files, and an array of lines for each of them is a real share of an index's
 * peak memory.
 */
class SourceLines {
  private readonly starts: Int32Array;
  readonly length: number;

  constructor(private readonly source: string) {
    scratch ??= new Int32Array(MAX_SOURCE_FILE_SIZE_BYTES + 2);
    let count = 1;
    for (let at = source.indexOf('\n'); at >= 0; at = source.indexOf('\n', at + 1)) scratch[count++] = at + 1;
    scratch[count] = source.length + 1;
    this.starts = scratch.slice(0, count + 1);
    this.length = count;
  }

  /** Line `index`, 0-based, without its newline; undefined past the last. */
  at(index: number): string | undefined {
    return index < 0 || index >= this.length ? undefined : this.source.slice(this.starts[index]!, this.starts[index + 1]! - 1);
  }

  /** Lines `from` to `to`, `to` left out. */
  text(from: number, to: number): string {
    return this.source.slice(this.starts[from]!, this.starts[Math.min(to, this.length)]! - 1);
  }
}

/** A class or module written as a constant path. */
const CONSTANT_PATH = /^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/;
/** `Foo.new` or `Foo::Bar.new(…)`; `closesAtEnd` checks the argument list. */
const CONSTRUCTED = /^((?:::)?[A-Z]\w*(?:::[A-Z]\w*)*)\.new(\(.*\))?$/;
/** A heredoc opener: what follows it is its body, not more arguments. */
const HEREDOC = /<<[~-]?["'`A-Za-z_]/;
const LOCAL_NAME = /^[a-z_]\w*$/;
const INSTANCE_VARIABLE = /^@(\w+)$/;
/** How far a call's argument list, or a `def`'s, is read before it isn't one this reader understands. */
const MAX_LIST_LINES = 40;
/** What ends a call written without parentheses. */
const STATEMENT_MODIFIER = /^(?:if|unless|while|until|rescue|do|and|or|then)\b/;
/** Calls that run a block, or a whole body, on some other `self`. */
const OTHER_SELF = /\b(?:instance_eval|instance_exec|class_eval|class_exec|module_eval|module_exec|define_method|define_singleton_method|Class\.new|Module\.new|Struct\.new|Data\.define)\b/;

/** A line past this can't be read exactly: the patterns below take time by the square of a line's length. */
const MAX_READ_LINE = 2_000;
const STATEMENT_ASSIGNMENT = /^\s*(@?[a-zA-Z_]\w*)\s*(?:\|\|)?=(?![=~>])\s*(.+)/s;
const ANY_ASSIGNMENT = /(?:^|[^.\w@$:])(@?[a-zA-Z_]\w*)\s*(?:[-+*/%|&^]|\*\*|\|\||&&|<<|>>)?=(?![=~>])/g;
const BLOCK_PARAMETERS = /(?:\bdo|\{)\s*\|([^|\n]*)\|/g;
const LAMBDA_PARAMETERS = /->\s*\(?([^)\n{]*)/g;
const RESCUED_OR_MATCHED = /(?:\brescue\b|^\s*in\b)[^\n]*=>\s*(@?[a-zA-Z_]\w*)/g;
const FOR_VARIABLES = /\bfor\s+([^\n]*?)\s+in\b/g;
const SEVERAL_ASSIGNMENT = /^\s*(\*?@?\w+(?:\s*,\s*\*?@?\w+)+)\s*=(?![=~>])/;
const PATTERN_CLAUSE = /^\s*in\s+(.+)$/;
const WORD = /@?[a-zA-Z_]\w*/g;
/** `word.call` or `word&.call`: the word, and the call. */
const CALL_ON_A_WORD = /(?<![\w.@$:])([a-z_]\w*)&?\.([a-zA-Z_]\w*[?!]?)/g;

function ownerOf(method: { qualifiedName: string }): string {
  const cut = method.qualifiedName.lastIndexOf('::');
  return cut < 0 ? '' : method.qualifiedName.slice(0, cut);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` cut at its commas outside any bracket or string. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  const open: string[] = [];
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === '\\') current += text[++i] ?? '';
      else if (ch === quote) quote = null;
    } else if (ch === ',' && open.length === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[' || ch === '{') open.push(ch);
      else if (ch === ')' || ch === ']' || ch === '}') open.pop();
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * The arguments that follow a call's name, from the character after it, cut at
 * the top-level commas. A call in parentheses ends at the one that closes it,
 * one without at the end of its statement. Null for what can't be read
 * exactly: a heredoc, or a list longer than a call has.
 */
function readArgumentList(lines: SourceLines, line: number, column: number): string[] | null {
  let text = lines.at(line)!;
  const parenthesized = text[column] === '(';
  let i = column + (parenthesized ? 1 : 0);
  if (!parenthesized) {
    // No space, or an operator, next: no arguments at all. `foo *args` and
    // `foo :a` are arguments, `foo * 2` and `foo ? a : b` aren't.
    if (!/^\s/.test(text.slice(i))) return [];
    const after = text.slice(i).trimStart();
    if (after === '' || after[0] === '#' || after[0] === ';' || after[0] === '{' || STATEMENT_MODIFIER.test(after) ||
      /^[-+*/%&|^<>=!?:.,)\]}]+(?:\s|$)/.test(after)) return [];
  }
  const parts: string[] = [];
  const open: string[] = [];
  let quote: string | null = null;
  let current = '';
  for (let row = line; ;) {
    if (i >= text.length) {
      const continues = parenthesized || open.length > 0 || quote !== null || /[,\\]\s*$/.test(current);
      if (!continues) break;
      if (++row > line + MAX_LIST_LINES || lines.at(row) === undefined) return null;
      text = lines.at(row)!;
      i = 0;
      current = `${current.replace(/\\\s*$/, '')} `;
      continue;
    }
    const ch = text[i++]!;
    if (quote !== null) {
      current += ch;
      if (ch === '\\') current += text[i++] ?? '';
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
    } else if (ch === '#' && (i === 1 || /\s/.test(text[i - 2]!))) {
      i = text.length;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      open.push(ch);
      current += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (open.length === 0) break;
      open.pop();
      current += ch;
    } else if (ch === ',' && open.length === 0) {
      parts.push(current.trim());
      current = '';
    } else if (!parenthesized && open.length === 0 && (ch === ';' || (/\s/.test(ch) && STATEMENT_MODIFIER.test(text.slice(i))))) {
      break;
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts.some((part) => HEREDOC.test(part)) ? null : parts;
}

/** Past the parenthesis that closes the one at (`line`, `column`). */
function closingParenthesis(lines: SourceLines, line: number, column: number): { line: number; column: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let row = line; row < lines.length && row <= line + MAX_LIST_LINES; row++) {
    const text = lines.at(row)!;
    for (let i = row === line ? column : 0; i < text.length; i++) {
      const ch = text[i]!;
      if (quote !== null) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return { line: row, column: i + 1 };
    }
  }
  return null;
}

/** The character after the called name at a site, past whatever its receiver is written as. */
function afterCalledName(site: FlowSite, lines: SourceLines): { line: number; column: number } | null {
  let line = site.line - 1;
  let text = lines.at(line);
  if (text === undefined) return null;
  let at = site.column;
  /** To the next code, across lines: a chain may break before its dot. */
  const skipSpace = (): boolean => {
    for (let hops = 0; hops < 8; hops++) {
      while (at < text!.length && /\s/.test(text![at]!)) at++;
      if (at < text!.length && text![at] !== '#') return true;
      text = lines.at(++line);
      at = 0;
      if (text === undefined) return false;
    }
    return false;
  };
  if (site.receiver === null) {
    // `self.foo` is recorded as a bare `foo`.
    if (text.startsWith('self.', at)) at += 5;
    else if (text.startsWith('self&.', at)) at += 6;
  } else if (site.receiver.startsWith('new ')) {
    const constant = site.receiver.slice(4, -2);
    if (!text.startsWith(constant, at)) return null;
    at += constant.length;
    if (!skipSpace() || !text!.startsWith('.new', at)) return null;
    at += 4;
    if (text![at] === '(') {
      const closed = closingParenthesis(lines, line, at);
      if (!closed) return null;
      line = closed.line;
      at = closed.column;
      text = lines.at(line);
    }
  } else {
    const written = site.receiver.split('\n');
    if (!text.startsWith(written[0]!.replace(/\r$/, ''), at)) return null;
    if (written.length > 1) {
      line += written.length - 1;
      text = lines.at(line);
      if (text === undefined) return null;
      at = written[written.length - 1]!.length;
    } else {
      at += site.receiver.length;
    }
  }
  if (site.receiver !== null) {
    if (!skipSpace()) return null;
    if (text!.startsWith('&.', at) || text!.startsWith('::', at)) at += 2;
    else if (text![at] === '.') at += 1;
    else return null;
    if (!skipSpace()) return null;
  }
  return text!.startsWith(site.method, at) ? { line, column: at + site.method.length } : null;
}

/** A written list of arguments, sorted out. */
function sortArguments(list: string[]): RubyArguments {
  const args: RubyArguments = { positional: [], keywords: new Map(), splatAt: -1, keywordSplat: false };
  for (const arg of list) {
    if (arg.startsWith('&')) continue;
    if (arg.startsWith('**')) {
      args.keywordSplat = true;
    } else if (arg.startsWith('*')) {
      if (args.splatAt < 0) args.splatAt = args.positional.length;
      args.positional.push(arg);
    } else {
      const label = /^([a-zA-Z_]\w*[?!]?):(?!:)\s*(.*)$/.exec(arg);
      if (label) args.keywords.set(label[1]!, label[2] === '' ? label[1]! : label[2]!);
      else if (arg.includes('=>') || /^"[^"]*":/.test(arg)) args.keywords.set(arg, arg);
      else args.positional.push(arg);
    }
  }
  return args;
}

/**
 * A `def`'s head: the text between its parentheses, or what follows it when it
 * has none, and whatever of the method follows on the line the list ends:
 * `def ok?(x) = x.ok?`, `def go(x); x = y`.
 */
function readHead(method: FlowMethod, lines: SourceLines): { list: string; rest: string } | null {
  const first = lines.at(method.startLine - 1)?.slice(method.startColumn);
  if (first === undefined) return null;
  const def = /\bdef\s+(?:[A-Za-z_:][\w:]*\.)?[^\s(;]+/.exec(first);
  if (!def) return null;
  let header = first.slice(def.index + def[0].length);
  if (!header.startsWith('(')) {
    const bare = /^(\s+[^;#=\n]*)?/.exec(header)![0];
    return { list: bare.trim(), rest: header.slice(bare.length) };
  }
  for (let row = method.startLine; ; row++) {
    let depth = 0;
    for (let i = 0; i < header.length; i++) {
      if (header[i] === '(') depth++;
      else if (header[i] === ')' && --depth === 0) return { list: header.slice(1, i), rest: header.slice(i + 1) };
    }
    const next = lines.at(row);
    if (next === undefined || row >= method.startLine + MAX_LIST_LINES) return null;
    header += ` ${next.replace(/\s#.*$/, '')}`;
  }
}

function readSignature(method: FlowMethod, lines: SourceLines): RubySignature | null {
  const head = readHead(method, lines);
  if (head === null) return null;
  const parameters: FlowParameter[] = [];
  const gathering = new Set<string>();
  let required = 0;
  let optional = 0;
  let rest = false;
  let takesKeywords = false;
  for (const parameter of splitTopLevel(head.list)) {
    const keyword = /^([a-z_]\w*):/.exec(parameter);
    const plain = /^([a-z_]\w*)\s*(=)?/.exec(parameter);
    if (keyword) {
      takesKeywords = true;
      parameters.push({ name: keyword[1]!, position: -1 });
    } else if (parameter.startsWith('**')) {
      takesKeywords = true;
      gathering.add(parameter.slice(2));
    } else if (parameter.startsWith('*') || parameter === '...') {
      rest = true;
      gathering.add(parameter.slice(1));
    } else if (parameter.startsWith('&')) {
      gathering.add(parameter.slice(1));
    } else if (plain) {
      // Past a splat, or a required one past an optional, its place depends on
      // how many a call passes.
      if (rest || (optional > 0 && !plain[2])) gathering.add(plain[1]!);
      else parameters.push({ name: plain[1]!, position: required + optional });
      if (plain[2]) optional++;
      else required++;
    } else {
      required++; // `(a, b)`, destructured: a place, and no one name's.
    }
  }
  return {
    parameters,
    gathering,
    rest: head.rest,
    accepts(args) {
      if (args.splatAt >= 0) return true;
      const fits = (n: number): boolean => n >= required && (rest || n <= required + optional);
      const n = args.positional.length;
      if (takesKeywords) return fits(n);
      if (args.keywords.size > 0) return fits(n + 1);
      return args.keywordSplat ? fits(n) || fits(n + 1) : fits(n);
    },
  };
}

/** What a method's head line past its parameters, and lines `from` to `to` (0-based, `to` left out), bind. */
function readBindings(headRest: string, lines: SourceLines, from: number, to: number): Bindings {
  const assigned = new Map<string, string[]>();
  const other = new Set<string>();
  const addWords = (text: string): void => {
    for (const word of text.matchAll(WORD)) other.add(word[0]);
  };
  for (let i = from - 1; i < to && i < lines.length; i++) {
    const line = i < from ? headRest : lines.at(i)!;
    if (line.length > MAX_READ_LINE) {
      addWords(line);
      continue;
    }
    const hasAssignment = line.includes('=');
    const hasBars = line.includes('|');
    const hasArrow = line.includes('->');
    const hasWordIn = line.includes(' in ') || line.startsWith('in ');
    if (!hasAssignment && !hasBars && !hasArrow && !hasWordIn) continue;
    if (hasAssignment) {
      const statement = STATEMENT_ASSIGNMENT.exec(line);
      if (statement) {
        const values = assigned.get(statement[1]!);
        const comment = statement[2]!.search(/\s#/);
        const value = (comment < 0 ? statement[2]! : statement[2]!.slice(0, comment)).trimEnd();
        if (values) values.push(value);
        else assigned.set(statement[1]!, [value]);
      }
      const offset = statement ? line.indexOf('=') + 1 : 0;
      for (const m of line.slice(offset).matchAll(ANY_ASSIGNMENT)) other.add(m[1]!);
      for (const m of line.matchAll(RESCUED_OR_MATCHED)) other.add(m[1]!);
      const several = SEVERAL_ASSIGNMENT.exec(line);
      if (several) addWords(several[1]!);
    }
    if (hasBars) for (const m of line.matchAll(BLOCK_PARAMETERS)) addWords(m[1]!);
    if (hasArrow) for (const m of line.matchAll(LAMBDA_PARAMETERS)) addWords(m[1]!);
    if (hasWordIn) {
      for (const m of line.matchAll(FOR_VARIABLES)) addWords(m[1]!);
      const clause = PATTERN_CLAUSE.exec(line);
      if (clause) addWords(clause[1]!);
    }
  }
  return { assigned, other };
}

/** Whether `argumentList`, from the `(` on, closes at its very end. */
function closesAtEnd(argumentList: string): boolean {
  let depth = 0;
  for (let i = 0; i < argumentList.length; i++) {
    const ch = argumentList[i];
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i === argumentList.length - 1;
  }
  return false;
}

/** The class a `Foo.new(…)` constructs, or null for any other text. */
function constructedClass(text: string): string | null {
  const made = CONSTRUCTED.exec(text);
  return made && (made[2] === undefined || closesAtEnd(made[2])) ? made[1]! : null;
}

export const rubyParameterFlow: ParameterFlowLanguage = {
  language: 'ruby',

  adapter(context, methods): ParameterFlowAdapter<RubySignature> {
    const root = context.getProjectRoot();
    const texts = new Map<string, string>();
    const sources = new Map<string, SourceLines>();
    const signatures = new Map<string, RubySignature | null>();
    const bindings = new Map<string, Bindings>();
    const argumentMemo = new Map<FlowSite, RubyArguments | null>();
    const selfMemo = new Map<string, boolean>();
    const usedElsewhere = new Map<string, RegExp>();

    /** A file's text; nothing for one extraction wouldn't take, or that can't be read. */
    const readText = (file: string): string => {
      try {
        const text = readSourceText(path.join(root, file)) ?? '';
        // It can have grown since the check.
        return text.length > MAX_SOURCE_FILE_SIZE_BYTES ? '' : text;
      } catch {
        return '';
      }
    };
    /** Each file is read once in a pass, whoever asks: on Windows an open costs more than what follows it. */
    const textOf = (file: string): string => {
      let text = texts.get(file);
      if (text === undefined) texts.set(file, (text = readText(file)));
      return text;
    };
    const linesOf = (file: string): SourceLines => {
      let lines = sources.get(file);
      if (!lines) sources.set(file, (lines = new SourceLines(textOf(file))));
      return lines;
    };

    /** The innermost class or module around a line. */
    const scopeAt = (file: string, line: number): FlowMethod | null => {
      let innermost: FlowMethod | null = null;
      for (const node of methods.scopesIn(file)) {
        if (node.startLine <= line && node.endLine >= line && (!innermost || node.endLine - node.startLine < innermost.endLine - innermost.startLine)) innermost = node;
      }
      return innermost;
    };

    const signatureOf = (method: FlowMethod): RubySignature | null => {
      let signature = signatures.get(method.id);
      if (signature === undefined) {
        signature = readSignature(method, linesOf(method.filePath));
        signatures.set(method.id, signature);
      }
      return signature;
    };

    /** What the body of a method, or the whole of a class, binds. */
    const bindingsOf = (node: FlowMethod): Bindings => {
      let bound = bindings.get(node.id);
      if (!bound) {
        bound = readBindings(signatureOf(node)?.rest ?? '', linesOf(node.filePath), node.startLine, node.endLine);
        bindings.set(node.id, bound);
      }
      return bound;
    };

    const argumentsAt = (site: FlowSite): RubyArguments | null => {
      let args = argumentMemo.get(site);
      if (args === undefined) {
        const lines = linesOf(site.filePath);
        const after = afterCalledName(site, lines);
        const list = after && readArgumentList(lines, after.line, after.column);
        args = list ? sortArguments(list) : null;
        argumentMemo.set(site, args);
      }
      return args;
    };

    /** Whether `method`, a `def` directly in its class, can only ever run with that class's `self`. */
    const selfIsTheClass = (method: FlowMethod, scope: FlowMethod): boolean => {
      let answer = selfMemo.get(method.id);
      if (answer !== undefined) return answer;
      const lines = linesOf(method.filePath);
      answer = true;
      for (let i = method.startLine - 1; answer && i < method.endLine && i < lines.length; i++) {
        if (OTHER_SELF.test(lines.at(i)!)) answer = false;
      }
      // A `def` inside a block of the class body (`included do`, `Struct.new
      // do`) belongs to whatever the block runs on.
      let indent = (lines.at(method.startLine - 1) ?? '').search(/\S/);
      for (let i = method.startLine - 2; answer && i >= scope.startLine; i--) {
        const line = lines.at(i)!;
        const at = line.search(/\S/);
        if (at < 0 || at >= indent || line[at] === '#') continue;
        indent = at;
        if (/(?:\bdo(?:\s*\|[^|]*\|)?|\{(?:\s*\|[^|]*\|)?)\s*(?:#.*)?$/.test(line)) answer = false;
      }
      selfMemo.set(method.id, answer);
      return answer;
    };

    /** The value of `self` at a site: only inside a method of a class says which. */
    const selfValue = (site: FlowSite): FlowValue | Abstention => {
      const caller = methods.get(site.callerId);
      if (!caller) return 'self-outside-a-method';
      const scope = scopeAt(site.filePath, site.line);
      if (!scope || scope.kind !== 'class' || ownerOf(caller) !== scope.qualifiedName) return 'self-in-a-module';
      if (!selfIsTheClass(caller, scope)) return 'self-in-a-block';
      return { type: scope.qualifiedName, isClass: caller.isStatic === 1, outside: false };
    };

    /** The class a constant written at a site names, itself or as what its `.new` makes. */
    const constantValue = (written: string, isClass: boolean, site: FlowSite): FlowValue | Abstention => {
      const top = written.startsWith('::');
      const name = top ? written.slice(2) : written;
      const qn = rubyConstantQn(name, top ? '' : scopeAt(site.filePath, site.line)?.qualifiedName ?? '', context);
      const declared = context.getNodesByQualifiedName(qn).filter((n) => n.language === 'ruby');
      if (declared.some((n) => n.kind === 'class')) return { type: qn, isClass, outside: false };
      if (declared.length > 0) return 'constant-is-no-class';
      // Nothing of the name anywhere is a class from outside. A namesake
      // elsewhere may be what an inherited constant lookup finds, which this
      // can't follow.
      if (context.getNodesByName(name.slice(name.lastIndexOf(':') + 1)).some((n) => n.language === 'ruby')) return 'constant-not-found';
      return { type: name, isClass, outside: true };
    };

    /** The value of a word at a site: a parameter of the calling method, or a local it assigns. */
    const wordValue = (word: string, site: FlowSite, follow: FollowParameter, depth: number): FlowValue | Abstention => {
      const caller = methods.get(site.callerId);
      if (!caller) return 'word-outside-a-method';
      const signature = signatureOf(caller);
      if (!signature) return 'unread-declaration';
      const parameter = signature.parameters.find((p) => p.name === word);
      if (parameter) return follow(caller, parameter);
      if (signature.gathering.has(word)) return 'gathered-parameter';
      const bound = bindingsOf(caller);
      if (bound.other.has(word)) return 'local-bound-otherwise';
      const assigned = bound.assigned.get(word);
      if (!assigned) return 'word-is-a-call';
      let value: FlowValue | null = null;
      for (const text of assigned) {
        const one = valueOf(text, site, follow, depth + 1);
        if (typeof one === 'string') return one;
        if (value && (value.type !== one.type || value.isClass !== one.isClass)) return 'sites-disagree';
        value = one;
      }
      return value!;
    };

    /** What a value written at a site is, when its text says so exactly. */
    const valueOf = (text: string, site: FlowSite, follow: FollowParameter, depth = 0): FlowValue | Abstention => {
      if (depth > 4) return 'too-deep';
      if (text === 'self') return selfValue(site);
      const made = constructedClass(text);
      if (made !== null) return constantValue(made, false, site);
      if (CONSTANT_PATH.test(text)) return constantValue(text, true, site);
      if (LOCAL_NAME.test(text)) return wordValue(text, site, follow, depth);
      const ivar = INSTANCE_VARIABLE.exec(text);
      if (ivar) {
        // Typed the way a call on the variable is, by the class's `initialize`.
        // In the site's own file, or a sync that edits it has no way here.
        const scope = scopeAt(site.filePath, site.line);
        if (scope && context.getNodesByQualifiedName(`${scope.qualifiedName}::initialize`).some((n) => n.filePath !== site.filePath)) return 'typed-in-another-file';
        const cls = ivarClass(ivar[1]!, { fromNodeId: site.callerId, referenceName: text, referenceKind: 'calls', line: site.line, column: site.column, filePath: site.filePath, language: 'ruby' }, context);
        return cls ? { type: cls.qualifiedName, isClass: false, outside: false } : 'untyped-instance-variable';
      }
      return 'untyped-argument';
    };

    return {
      readCall(referenceName) {
        const dot = referenceName.lastIndexOf('.');
        const method = dot < 0 ? referenceName : referenceName.slice(dot + 1);
        return /^[A-Za-z_]\w*[?!]?$/.test(method) ? { method, receiver: dot < 0 ? null : referenceName.slice(0, dot) } : null;
      },

      receivers(method) {
        const calls = new Map<string, Set<string>>();
        const lines = linesOf(method.filePath);
        const add = (text: string): void => {
          for (const m of text.matchAll(CALL_ON_A_WORD)) {
            const names = calls.get(m[1]!);
            if (names) names.add(m[2]!);
            else calls.set(m[1]!, new Set([m[2]!]));
          }
        };
        add(signatureOf(method)?.rest ?? '');
        if (method.endLine > method.startLine) add(lines.text(method.startLine, method.endLine));
        return calls;
      },

      isKnown(site) {
        if (site.targetId === null || site.viaFlow) return false;
        if (site.receiver !== null) return site.confidence >= 0.85;
        // A call with no receiver is a call on `self`. In a class, resolution
        // took it only from what the class answers. In a module or a script it
        // found it by its name, unless the module declares it.
        const scope = scopeAt(site.filePath, site.line);
        const target = methods.get(site.targetId);
        if (!scope || !target) return false;
        return scope.kind === 'class' || ownerOf(target) === scope.qualifiedName;
      },

      cannotCall(site, signature) {
        // A class named as the receiver was asked for a method of its own, so
        // no instance's is reached. A constant holding a value may be anything.
        if (site.receiver !== null && CONSTANT_PATH.test(site.receiver) &&
          !context.getNodesByName(site.receiver.slice(site.receiver.lastIndexOf(':') + 1))
            .some((n) => n.language === 'ruby' && (n.kind === 'constant' || n.kind === 'variable'))) return true;
        const args = argumentsAt(site);
        return args !== null && !signature.accepts(args);
      },

      signature: signatureOf,

      family(method) {
        const owner = ownerOf(method);
        const up = rubyAncestry(owner, context, true);
        const family = new Set([method.id]);
        for (const other of context.getNodesByName(method.name)) {
          if (other.kind !== 'method' || other.language !== 'ruby' || (other.isStatic === true) !== (method.isStatic === 1)) continue;
          const theirs = ownerOf(other);
          if (up.has(theirs) || rubyAncestry(theirs, context, true).has(owner)) family.add(other.id);
        }
        return family;
      },

      handsOn(name) {
        return context.getNodesByName(name).some((n) => {
          if (n.kind !== 'method' || n.language !== 'ruby') return false;
          const lines = linesOf(n.filePath);
          for (let i = n.startLine - 1; i < n.endLine && i < lines.length; i++) {
            if (lines.at(i)!.includes('super') && /\bsuper\b/.test(lines.at(i)!)) return true;
          }
          return false;
        });
      },

      rebinds(name, method) {
        const bound = bindingsOf(method);
        return bound.other.has(name) || bound.assigned.has(name);
      },

      shapesClass(name) {
        return name === 'initialize'; // What types an instance variable.
      },

      passesOn(name, method) {
        let elsewhere = usedElsewhere.get(name);
        if (!elsewhere) usedElsewhere.set(name, (elsewhere = new RegExp(`(?<![\\w.@$:])${escapeRegExp(name)}(?![\\w?!]|\\s*&?\\.)`)));
        return elsewhere.test(signatureOf(method)?.rest ?? '') ||
          (method.endLine > method.startLine && elsewhere.test(linesOf(method.filePath).text(method.startLine, method.endLine)));
      },

      passesWord(site) {
        const args = argumentsAt(site);
        // One it can't read may be anything.
        return args === null || args.positional.some((text) => LOCAL_NAME.test(text)) || [...args.keywords.values()].some((text) => LOCAL_NAME.test(text));
      },

      argumentValue(site, parameter, follow) {
        const args = argumentsAt(site);
        if (!args) return 'unread-call';
        let text: string | undefined;
        if (parameter.position < 0) {
          text = args.keywords.get(parameter.name);
          if (text === undefined && args.keywordSplat) return 'keyword-splat';
        } else {
          if (args.splatAt >= 0 && args.splatAt <= parameter.position) return 'splat';
          text = args.positional[parameter.position];
        }
        return text === undefined ? 'not-passed' : valueOf(text, site, follow);
      },

      methodOn(value, name) {
        if (value.outside) return null;
        const first = (found: Node[]): FlowMethod | null => {
          const node = [...found].sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.startLine - b.startLine))[0];
          return node ? methods.get(node.id) ?? null : null;
        };
        if (value.isClass) {
          const inherited = rubyClassMethodOf(value.type, name, context);
          return first(rubyMethodsOf(value.type, name, context).filter((n) => n.isStatic === true)) ??
            (inherited ? methods.get(inherited.id) ?? null : null);
        }
        for (const owner of rubyAncestry(value.type, context, true)) {
          const method = first(rubyMethodsOf(owner, name, context).filter((n) => n.isStatic !== true));
          if (method) return method;
        }
        return null;
      },

      answersItself(value, name) {
        if (value.outside) return true;
        if (value.isClass) return false;
        // `attr_reader :name`, in a list that may run over lines.
        const reader = new RegExp(String.raw`\battr_(?:reader|accessor)\s+(?::\w+[?!]?\s*,\s*)*:${escapeRegExp(name)}(?![\w?!])`);
        for (const owner of rubyAncestry(value.type, context, true)) {
          for (const declaration of context.getNodesByQualifiedName(owner)) {
            if (declaration.language !== 'ruby' || (declaration.kind !== 'class' && declaration.kind !== 'module')) continue;
            if (reader.test(linesOf(declaration.filePath).text(declaration.startLine - 1, declaration.endLine))) return true;
          }
        }
        return false;
      },

      declared(name) {
        return context.getNodesByName(name).filter((n) => n.language === 'ruby' && (n.kind === 'method' || n.kind === 'function')).length;
      },

      async written(names, files) {
        // Every place the code writes one of the names, whatever for. The graph
        // records no call in a class body or a block at the top of a file
        // (`test "x" do`, a spec's `it do`), and no symbol, string or alias, so
        // a count is what finds them all. A local of the name costs an answer,
        // never a wrong one.
        const written = new Map<string, Map<string, number>>();
        if (names.size === 0) return written;
        const word = new RegExp(`(?<![\\w@$])(?:${[...names].map(escapeRegExp).join('|')})(?![\\w?!])`, 'g');
        const maybeYield = createYielder();
        for (const file of files) {
          const text = texts.get(file) ?? readText(file);
          // A comment calls nothing. Asked once a line: a line can be all matches.
          let lineEnd = -1;
          let inComment = false;
          for (const m of text.matchAll(word)) {
            if (m.index > lineEnd) {
              const lineStart = text.lastIndexOf('\n', m.index) + 1;
              const end = text.indexOf('\n', m.index);
              lineEnd = end < 0 ? text.length : end;
              inComment = /^[ \t]*#/.test(text.slice(lineStart, lineEnd));
            }
            if (inComment) continue;
            let byFile = written.get(m[0]);
            if (!byFile) written.set(m[0], (byFile = new Map()));
            byFile.set(file, (byFile.get(file) ?? 0) + 1);
          }
          const pause = maybeYield();
          if (pause) await pause;
        }
        return written;
      },
    };
  },
};
