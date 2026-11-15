/** AST-backed LuaJIT provenance. A name resembling `ffi` is never evidence.
 *
 * Names are resolved lexically once, so every read and write denotes one
 * binding. Values then flow through each function body in order: branches
 * join, loops cover zero or more iterations, and a binding that another
 * function writes is never proven past those writes. Facts shared between
 * functions (binding summaries, function returns, table members, mutated
 * namespaces, what each function writes through its parameters) reach a fixed
 * point; a function's calls come from its last run, which saw every fact it
 * read in final form.
 *
 * Code another file holds, or C, is assumed to change what it is handed and
 * everything reachable from it, and nothing else: a stub one file installs in
 * a module is that file's, not every file's. */
import { getParser } from '../extraction/grammars';
import { parseWithinBudget } from '../extraction/parse-budget';
import { mirrorTree, type SyntaxMirror as SyntaxNode } from './syntax-mirror';

export interface LuaCall {
  callee: string;
  resolvedCallee?: string;
  importedModule?: string;
  startIndex: number;
  endIndex: number;
  line: number;
  column: number;
  ffiSymbol?: string;
  functionStartIndex?: number;
}
export interface LuaFunction {
  name: string;
  startIndex: number;
  endIndex: number;
  line: number;
  column: number;
  endLine: number;
  /** The function whose body defines this one; none at chunk level. */
  parentStartIndex?: number;
}
export interface LuaAnalysis {
  calls: LuaCall[];
  functions: LuaFunction[];
  /** Member paths of the returned module that hold a library (`''` for the module itself), and of its functions that return one. */
  exportedLibraries: string[];
  exportedLoaders: string[];
  /** Functions declared by literal `ffi.cdef` text: name → linked symbols (an `asm` label, else the name). */
  cdefSymbols: Record<string, string[]>;
  /** No grammar, or the parse ran past its budget: nothing here is evidence, and no cache keeps it. */
  partial?: true;
}

type Value =
  | { kind: 'bottom' | 'nil' | 'unknown' | 'ffi' | 'loader' }
  /** A global this file never assigns, or a member of one, that the analysis gives meaning to. */
  | { kind: 'builtin'; name: string }
  | { kind: 'library'; ids: number[] }
  | { kind: 'string' | 'number'; value: string }
  | { kind: 'parameter' | 'parameter_member'; index: number; owner: number }
  | { kind: 'function'; startIndex: number }
  | { kind: 'table'; id: number }
  | { kind: 'module'; module: string; member: string }
  | { kind: 'symbol'; name: string };
/** Not yet known during the fixed point; it defers to every other value. */
const BOTTOM: Value = { kind: 'bottom' };
const NIL: Value = { kind: 'nil' };
const UNKNOWN: Value = { kind: 'unknown' };
/** `ffi.C` is one shared namespace, wherever it is spelled. */
const FFI_C = -1;
const CHUNK = -1;

interface Binding {
  readonly id: number;
  readonly name: string;
  readonly kind: 'local' | 'parameter' | 'global';
  /** The unit whose body declares it; globals have none. */
  readonly unit?: number;
  /** Assigned inside a goto region, or named inside a syntax error. Never proven. */
  volatile?: boolean;
  /** Globals only: this file assigns it, so it is not a builtin. */
  assigned?: boolean;
}
interface Unit {
  readonly id: number;
  /** The unit whose body defines this function. */
  readonly parent: number;
  readonly node: SyntaxNode;
  readonly name: string;
  readonly params: Binding[];
  /** It takes `...`: arguments past its parameters reach code the analysis does not follow. */
  readonly vararg: boolean;
}

function field(n: SyntaxNode, name: string): SyntaxNode | null { return n.childForFieldName(name); }
function children(n: SyntaxNode): SyntaxNode[] { return n.significantChildren; }
function same(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'library': { const ids = (b as typeof a).ids; return a.ids.length === ids.length && a.ids.every((id, i) => id === ids[i]); }
    case 'string': case 'number': return a.value === (b as typeof a).value;
    case 'parameter': case 'parameter_member': return a.index === (b as typeof a).index && a.owner === (b as typeof a).owner;
    case 'function': return a.startIndex === (b as typeof a).startIndex;
    case 'table': return a.id === (b as typeof a).id;
    case 'module': return a.module === (b as typeof a).module && a.member === (b as typeof a).member;
    case 'symbol': case 'builtin': return a.name === (b as typeof a).name;
    default: return true;
  }
}
/** Nil and not-yet-known values defer to the others; any other disagreement is unknown. */
function join(a: Value, b: Value): Value {
  if (a.kind === 'bottom') return b;
  if (b.kind === 'bottom') return a;
  if (a.kind === 'nil') return b;
  if (b.kind === 'nil') return a;
  if (a.kind === 'library' && b.kind === 'library') {
    return same(a, b) ? a : { kind: 'library', ids: [...new Set([...a.ids, ...b.ids])].sort((x, y) => x - y) };
  }
  return same(a, b) ? a : UNKNOWN;
}
function literal(n: SyntaxNode): string | undefined {
  if (n.type !== 'string') return undefined;
  // Decode only literals, never source text containing comments or expressions.
  const raw = n.text;
  const long = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(raw);
  if (long) return long[2]!.replace(/^\r?\n/, '');
  if ((raw[0] !== '"' && raw[0] !== "'") || raw.at(-1) !== raw[0]) return undefined;
  let result = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i]!;
    if (c !== '\\') { result += c; continue; }
    const next = raw[++i];
    if (next === undefined) return undefined;
    const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
    if (next in escapes) result += escapes[next];
    else if (next === '\n') result += '\n';
    else return undefined; // Unknown escape: do not guess the exported symbol.
  }
  return result;
}
/** C function declarations in literal cdef text; an `asm` label renames the linked symbol. */
function cdefFunctions(text: string): Array<[string, string]> {
  const declarations: Array<[string, string]> = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const declaration of code.split(';')) {
    const match = /([A-Za-z_]\w*)\s*\((?:[^()]|\([^()]*\))*\)\s*(?:(?:__asm__|asm)\s*\(\s*"([^"\\]+)"\s*\))?\s*$/.exec(declaration);
    if (match) declarations.push([match[1]!, match[2] ?? match[1]!]);
  }
  return declarations;
}

/** Lexical bindings for every identifier, plus the analysis units (chunk and functions). */
function resolveScopes(root: SyntaxNode) {
  const refs = new Map<number, Binding>();
  const decls = new Map<number, Binding>();
  const globals = new Map<string, Binding>();
  const bindings: Binding[] = [];
  const units: Unit[] = [{ id: CHUNK, parent: CHUNK, node: root, name: '', params: [], vararg: true }];
  const scopes: Array<Map<string, Binding>> = [];
  let unit = CHUNK;
  // Statements inside a block that holds a label may run out of order.
  let regions = 0;
  const make = (name: string, kind: Binding['kind']): Binding => {
    const binding: Binding = { id: bindings.length, name, kind, ...(kind === 'global' ? {} : { unit }) };
    bindings.push(binding);
    return binding;
  };
  const lookup = (name: string): Binding => {
    for (let i = scopes.length - 1; i >= 0; i--) { const found = scopes[i]!.get(name); if (found) return found; }
    let global = globals.get(name);
    if (!global) globals.set(name, global = make(name, 'global'));
    return global;
  };
  const declare = (node: SyntaxNode, kind: 'local' | 'parameter'): Binding => {
    const binding = make(node.text, kind);
    if (regions) binding.volatile = true;
    scopes.at(-1)!.set(node.text, binding);
    decls.set(node.startIndex, binding);
    return binding;
  };
  const reference = (node: SyntaxNode, write = false): Binding => {
    const binding = lookup(node.text);
    refs.set(node.startIndex, binding);
    if (write) {
      if (binding.kind === 'global') binding.assigned = true;
      if (regions) binding.volatile = true;
    }
    return binding;
  };
  const statements = (block: SyntaxNode | null, then?: () => void): void => {
    scopes.push(new Map());
    const region = !!block && children(block).some(c => c.type === 'label_statement');
    if (region) regions++;
    if (block) for (const statement of children(block)) walk(statement);
    then?.();
    if (region) regions--;
    scopes.pop();
  };
  const target = (node: SyntaxNode): void => {
    // Member targets read their receiver chain; bracket keys and calls are expressions.
    if (node.type === 'identifier') { reference(node); return; }
    if (node.type !== 'dot_index_expression' && node.type !== 'method_index_expression' && node.type !== 'bracket_index_expression') { walk(node); return; }
    if (node.type === 'bracket_index_expression') walk(field(node, 'field'));
    const table = field(node, 'table');
    if (table) target(table);
  };
  const fn = (node: SyntaxNode, name: string, method: boolean): void => {
    const params = field(node, 'parameters');
    const parameters = params ? children(params).filter(p => p.type === 'identifier') : [];
    const saved = { unit, regions };
    const parent = unit;
    unit = node.startIndex; regions = 0;
    scopes.push(new Map());
    const bound: Binding[] = [];
    if (method) { const self = make('self', 'parameter'); scopes.at(-1)!.set('self', self); bound.push(self); }
    parameters.forEach(p => bound.push(declare(p, 'parameter')));
    const vararg = !!params && children(params).some(p => p.type === 'vararg_expression');
    units.push({ id: node.startIndex, parent, node, name, params: bound, vararg });
    statements(field(node, 'body'));
    scopes.pop();
    ({ unit, regions } = saved);
  };
  const walk = (n: SyntaxNode | null, assignedName?: string): void => {
    if (!n) return;
    switch (n.type) {
      case 'comment': case 'goto_statement': case 'label_statement': case 'break_statement': case 'attribute': return;
      case 'ERROR':
        // A recovered parse can hide an assignment; never prove a name it mentions.
        for (const id of n.descendantsOfType('identifier')) lookup(id.text).volatile = true;
        return;
      case 'identifier': reference(n); return;
      case 'block': statements(n); return;
      case 'do_statement': statements(field(n, 'body')); return;
      case 'while_statement': walk(field(n, 'condition')); statements(field(n, 'body')); return;
      case 'repeat_statement': statements(field(n, 'body'), () => walk(field(n, 'condition'))); return;
      case 'if_statement':
        walk(field(n, 'condition')); statements(field(n, 'consequence'));
        for (const alternative of children(n)) {
          if (alternative.type === 'elseif_statement') { walk(field(alternative, 'condition')); statements(field(alternative, 'consequence')); }
          else if (alternative.type === 'else_statement') statements(field(alternative, 'body'));
        }
        return;
      case 'for_statement': {
        const clause = field(n, 'clause');
        let names: SyntaxNode[] = [];
        if (clause?.type === 'for_numeric_clause') {
          walk(field(clause, 'start')); walk(field(clause, 'end')); walk(field(clause, 'step'));
          names = [field(clause, 'name')].filter((v): v is SyntaxNode => v !== null);
        } else if (clause) {
          walk(children(clause).find(c => c.type === 'expression_list') ?? null);
          names = children(children(clause).find(c => c.type === 'variable_list') ?? clause).filter(c => c.type === 'identifier');
        }
        scopes.push(new Map());
        names.forEach(name => declare(name, 'local'));
        statements(field(n, 'body'));
        scopes.pop();
        return;
      }
      case 'variable_declaration': {
        const assign = children(n).find(c => c.type === 'assignment_statement');
        const vars = children(assign ?? n).find(c => c.type === 'variable_list');
        const exprs = assign ? children(assign).find(c => c.type === 'expression_list') : undefined;
        const targets = vars ? children(vars).filter(c => c.type === 'identifier') : [];
        (exprs ? children(exprs) : []).forEach((e, i) => {
          if (e.type === 'function_definition' && targets[i]) fn(e, targets[i]!.text, false);
          else walk(e, targets[i]?.text);
        });
        targets.forEach(t => declare(t, 'local'));
        return;
      }
      case 'assignment_statement': {
        const targets = children(children(n).find(c => c.type === 'variable_list') ?? n).filter(c => c.type !== 'expression_list');
        const exprs = children(n).find(c => c.type === 'expression_list');
        (exprs ? children(exprs) : []).forEach((e, i) => {
          const t = targets[i];
          if (e.type === 'function_definition' && t?.type === 'identifier') fn(e, t.text, false);
          else walk(e, t?.text);
        });
        for (const t of targets) { if (t.type === 'identifier') reference(t, true); else target(t); }
        return;
      }
      case 'function_declaration': {
        const name = field(n, 'name');
        if (name?.type === 'identifier') {
          if (n.children.some(c => c.type === 'local')) declare(name, 'local');
          else reference(name, true);
        } else if (name) target(name);
        fn(n, name?.text ?? assignedName ?? '', name?.type === 'method_index_expression');
        return;
      }
      case 'function_definition': fn(n, assignedName ?? '', false); return;
      case 'table_constructor':
        for (const entry of children(n)) {
          const keyNode = field(entry, 'name');
          const bracketed = entry.children.some(c => c.type === '[');
          const key = keyNode?.type === 'identifier' && !bracketed ? keyNode.text : keyNode ? literal(keyNode) : undefined;
          if (bracketed) walk(keyNode);
          walk(field(entry, 'value'), key ? assignedName ? `${assignedName}.${key}` : key : undefined);
        }
        return;
      case 'dot_index_expression': case 'method_index_expression': walk(field(n, 'table')); return;
      case 'bracket_index_expression': walk(field(n, 'table')); walk(field(n, 'field')); return;
      default: for (const child of children(n)) walk(child);
    }
  };
  scopes.push(new Map());
  const region = children(root).some(c => c.type === 'label_statement');
  if (region) regions++;
  for (const statement of children(root)) walk(statement);
  return { refs, decls, bindings, units };
}

/** Flow-sensitive values of one unit's bindings; a branch or loop iteration is a child layer. */
class State {
  readonly values = new Map<number, Value>();
  constructor(readonly parent: State | null) {}
  get(id: number): Value | undefined {
    for (let s: State | null = this; s; s = s.parent) { const v = s.values.get(id); if (v !== undefined) return v; }
    return undefined;
  }
}
/** What a run reports. A unit's last run saw every fact it read in final form. */
interface Log {
  readonly calls: LuaCall[];
  readonly returns: Array<{ value: Value; unconditional: boolean }>;
  readonly cdefs: Array<[string, string]>;
}
const emptyLog = (): Log => ({ calls: [], returns: [], cdefs: [] });
interface Run {
  readonly unit: Unit;
  state: State;
  log: Log;
  /** Joined values this run wrote, per binding and per table member. */
  readonly writes: Map<number, Value>;
  readonly members: Map<number, Map<string, Value>>;
  /** Shared facts this run read: b<binding>, t<table>, g<function return>, m<module>, l<library>, and the rest. */
  readonly reads: Set<string>;
  /** Per enclosing loop: its head and a snapshot of the state at each break. */
  readonly exits: Array<{ head: State; states: State[] }>;
  /** What the function returns, when it is a namespace; unknown otherwise. */
  returned?: Value;
}

/**
 * The walks recurse once per level of nesting, so a file nested deeper than
 * this, like generated code with a long `..` chain, is declined rather than
 * allowed to exhaust the stack. Hand-written code nests far less.
 */
const MAX_DEPTH = 400;
/** Thrown when an analysis has done more work than its file can justify. */
class OverBudget extends Error {}

/** The caller preloads the Lua grammar; no AST objects escape this function. */
export function analyzeLua(source: string): LuaAnalysis {
  const partial: LuaAnalysis = { calls: [], functions: [], exportedLibraries: [], exportedLoaders: [], cdefSymbols: {}, partial: true };
  const parser = getParser('lua');
  const tree = parser && parseWithinBudget(parser, source);
  if (!tree) return partial;
  let root: SyntaxNode;
  try { root = mirrorTree(tree, source); } finally { tree.delete(); }
  // A file the parser could not read as a chunk proves nothing, nor does one
  // nested past what the walks follow or an analysis that ran out of budget.
  if (root.type === 'ERROR' || root.depth > MAX_DEPTH) return partial;
  try {
    return analyzeTree(root) ?? partial;
  } catch (error) {
    if (error instanceof OverBudget || error instanceof RangeError) return partial;
    throw error;
  }
}

function analyzeTree(root: SyntaxNode): LuaAnalysis | null {
  const { refs, decls, bindings, units } = resolveScopes(root);
  // Loops re-converge on every entry, so nested loops multiply the work; the
  // budget bounds it in proportion to the file.
  let steps = 0;
  const stepBudget = 100_000 + 200 * root.size;
  const step = (): void => { if (++steps > stepBudget) throw new OverBudget(); };
  const result: LuaAnalysis = { calls: [], functions: [], exportedLibraries: [], exportedLoaders: [], cdefSymbols: {} };
  // Shared facts, each the join of the latest run of every unit.
  const bindingWrites = new Map<number, Map<number, Value>>();
  const memberWrites = new Map<number, Map<string, Map<number, Value>>>();
  /** What each function returns, when it is a namespace: every return joined, so `ffi.load(path)` on one branch and `nil` on another is that library. */
  const returnsOf = new Map<number, Value>(units.filter(u => u.id !== CHUNK).map(u => [u.id, BOTTOM]));
  const invalidTables = new Set<number>();
  const invalidLibraries = new Set<number>();
  /** Written module member paths: `a.b` replaces it and its members, `a.*` any member of `a`, `*` any member, '' the whole namespace. */
  const invalidModules = new Map<string, Set<string>>();
  const logs = new Map<number, Log>();
  // Invalidations made by the current run; only their readers run again.
  const changed: string[] = [];
  const invalidate = <T>(set: Set<T>, item: T, key: string): void => { if (!set.has(item)) { set.add(item); changed.push(key); } };
  /** Every module at once: a write through `package.loaded` under a key the analysis can't read. */
  const ALL_MODULES = '\0*';
  const invalidateModule = (module: string, path: string): void => {
    const paths = invalidModules.get(module) ?? new Set<string>();
    invalidModules.set(module, paths);
    invalidate(paths, path, module === ALL_MODULES ? 'm*' : 'm' + module);
  };
  /** Namespaces (modules, or `ffi`) a value the analysis lost track of may hold. */
  const escapedModules = new Set<string>();
  const replaced = (module: string, member: string): boolean => {
    if (invalidModules.has(ALL_MODULES)) return true;
    for (const path of invalidModules.get(module) ?? []) {
      if (path === '' || (path === '*' && member !== '')) return true;
      if (path.endsWith('.*') ? member.startsWith(path.slice(0, -1)) : member === path || member.startsWith(path + '.')) return true;
    }
    // A write through a receiver the analysis can't resolve may land in an escaped namespace, or any table on a member's path.
    return escapedModules.has(module) && member !== '' && (untracked.has('*') || member.split('.').some(segment => untracked.has(segment)));
  };
  /** Globals the analysis gives meaning to, while this file never assigns them, and the members of them it reads. */
  const BUILTINS = new Set(['require', 'pcall', 'assert', 'error', 'getmetatable', 'setmetatable', 'ipairs', 'pairs', 'next', 'print',
    'rawequal', 'rawget', 'rawlen', 'select', 'tonumber', 'tostring', 'type', 'unpack', 'table', 'package']);
  const BUILTIN_MEMBERS = new Set(['table.concat', 'table.insert', 'table.remove', 'table.sort', 'table.unpack', 'package.loaded', 'package.preload']);
  /** Builtins that assign no named member of what they are given. What they are given still leaves the analysis's sight. */
  const PURE = new Set(['assert', 'error', 'getmetatable', 'ipairs', 'next', 'pairs', 'print', 'rawequal', 'rawget', 'rawlen',
    'select', 'setmetatable', 'tonumber', 'tostring', 'type', 'unpack', 'table.concat', 'table.insert', 'table.remove', 'table.sort', 'table.unpack']);
  const isBuiltin = (value: Value, name: string): boolean => value.kind === 'builtin' && value.name === name;
  const parentOf = new Map(units.map(unit => [unit.id, unit.parent]));
  const unitsById = new Map(units.map(unit => [unit.id, unit]));
  /** A parameter is a value only inside its own function and the closures nested in it. */
  const scoped = (value: Value, unit: number | undefined): Value => {
    if (value.kind !== 'parameter' && value.kind !== 'parameter_member') return value;
    for (let u = unit; u !== undefined; u = u === CHUNK ? undefined : parentOf.get(u)) if (u === value.owner) return value;
    return UNKNOWN;
  };

  // Writes the analysis can't place. Code the file can't follow (another file,
  // a C function) is assumed to change what it is handed, and everything
  // reachable from it, but nothing else; a write through a receiver the
  // analysis can't resolve is assumed to land in any table that has left its
  // sight, under the key written.
  /** Tables that code the analysis can't follow may reach. */
  const escaped = new Set<number>();
  /** Member keys written through receivers the analysis can't resolve; '*' for any key. */
  const untracked = new Set<string>();
  /**
   * What each function does to its arguments, per parameter: the member keys
   * it writes ('*' any), '**' when it hands the argument to code the analysis
   * can't follow, '^' when the argument escapes.
   */
  const effects = new Map<number, Map<number, Set<string>>>();
  const addEffect = (value: Value, key: string): void => {
    if (value.kind !== 'parameter' && value.kind !== 'parameter_member') return;
    // A write below a member of the parameter changes something reachable from it.
    const effect = value.kind === 'parameter_member' && key !== '^' ? '**' : key;
    let byParameter = effects.get(value.owner);
    if (!byParameter) effects.set(value.owner, byParameter = new Map());
    let keys = byParameter.get(value.index);
    if (!keys) byParameter.set(value.index, keys = new Set());
    invalidate(keys, effect, 's' + value.owner);
  };
  const membersOf = (id: number, run: Run): Value[] => {
    const values: Value[] = [];
    for (const writes of memberWrites.get(id)?.values() ?? []) values.push(...writes.values());
    values.push(...(run.members.get(id)?.values() ?? []));
    return values;
  };
  /** The value, and every table reachable from it, leaves the analysis's sight. */
  const escape = (value: Value, run: Run): void => {
    const pending = [value];
    while (pending.length) {
      const next = pending.pop()!;
      if (next.kind === 'parameter' || next.kind === 'parameter_member') addEffect(next, '^');
      if (next.kind !== 'table' || escaped.has(next.id)) continue;
      invalidate(escaped, next.id, 'e' + next.id);
      pending.push(...membersOf(next.id, run));
    }
  };
  /** The run in progress; outside the fixed point there is none, and nothing more can change. */
  let current: Run | undefined;
  /**
   * Two values that disagree join to unknown, and a write through that unknown
   * value may land in either: each one leaves the analysis's sight.
   */
  const merge = (a: Value, b: Value): Value => {
    const value = join(a, b);
    if (value.kind === 'unknown' && current) for (const lost of [a, b]) {
      if (lost.kind === 'table' || lost.kind === 'parameter' || lost.kind === 'parameter_member') escape(lost, current);
      // What a module's function returned is another object than the module: losing it loses nothing of the module.
      else if (lost.kind === 'module' && !lost.member.includes('()')) invalidate(escapedModules, lost.module, 'm' + lost.module);
      else if (lost.kind === 'ffi') invalidate(escapedModules, 'ffi', 'mffi');
    }
    return value;
  };
  /** The value is handed to code the analysis can't follow, which may change anything reachable from it. */
  const surrender = (value: Value, run: Run): void => {
    const pending = [value];
    const seen = new Set<number>();
    while (pending.length) {
      const next = pending.pop()!;
      switch (next.kind) {
        case 'parameter': case 'parameter_member': addEffect(next, '**'); break;
        case 'table':
          if (seen.has(next.id)) break;
          seen.add(next.id);
          invalidate(invalidTables, next.id, 't' + next.id);
          pending.push(...membersOf(next.id, run));
          break;
        case 'module': invalidateModule(next.module, next.member ? `${next.member}.*` : '*'); break;
        case 'ffi': invalidateModule('ffi', ''); break;
        case 'builtin': if (next.name.startsWith('package')) invalidateModule(ALL_MODULES, ''); break;
        default: break;
      }
    }
  };
  /** A write of member `key` ('*' for a key the analysis can't read) into `receiver`. */
  const rewrite = (receiver: Value, key: string, run: Run): void => {
    switch (receiver.kind) {
      case 'table':
        if (key === '*') invalidate(invalidTables, receiver.id, 't' + receiver.id);
        else writeMember(receiver.id, key, UNKNOWN, run);
        break;
      // A write through a namespace replaces what it names for every alias, in every function.
      case 'module':
        invalidateModule(receiver.module, key === '*' ? receiver.member ? `${receiver.member}.*` : '*' : receiver.member ? `${receiver.member}.${key}` : key);
        break;
      case 'ffi': invalidateModule('ffi', ''); break;
      case 'library': receiver.ids.forEach(id => invalidate(invalidLibraries, id, 'l' + id)); break;
      case 'builtin':
        // `package.loaded.name = …` and `package.preload.name = …` replace what `require("name")` returns.
        if (receiver.name === 'package.loaded' || receiver.name === 'package.preload') invalidateModule(key === '*' ? ALL_MODULES : key, '');
        // Replacing those tables or the searchers can change any module; a search path changes none the project holds.
        else if (receiver.name === 'package' && ['loaded', 'preload', 'searchers', 'loaders', '*'].includes(key)) invalidateModule(ALL_MODULES, '');
        break;
      case 'parameter': case 'parameter_member': addEffect(receiver, key); break;
      default: break;
    }
  };
  /** What a call does to its arguments (the receiver first, for `a:b()`): a known function's effects, else code the analysis can't follow. */
  const pass = (callee: Value, passed: Value[], run: Run): void => {
    const unit = callee.kind === 'function' ? unitsById.get(callee.startIndex) : undefined;
    if (unit) {
      run.reads.add('s' + unit.id);
      for (const [index, keys] of effects.get(unit.id) ?? []) {
        const value = passed[index];
        if (value) for (const key of keys) {
          if (key === '**') surrender(value, run);
          else if (key === '^') escape(value, run);
          else rewrite(value, key, run);
        }
      }
      // Arguments past the parameters reach `...`, which the analysis does not follow.
      if (unit.vararg) passed.slice(unit.params.length).forEach(value => surrender(value, run));
    } else if (callee.kind === 'builtin' && PURE.has(callee.name)) {
      // `assert` returns its argument, which the analysis then follows.
      if (callee.name !== 'assert') passed.forEach(value => escape(value, run));
    } else {
      // A module handed to its own function, as `M:f()` hands `M`, stays: what
      // that module's code writes through its parameters is withdrawn where it
      // is defined, from what the module exports.
      const own = callee.kind === 'module' ? callee.module : undefined;
      passed.forEach(value => { if (!(value.kind === 'module' && value.module === own)) surrender(value, run); });
    }
  };

  const argsOf = (n: SyntaxNode): SyntaxNode[] => { const args = field(n, 'arguments'); return args ? children(args) : []; };
  const proven = (value: Value, run: Run): Value => {
    if (value.kind === 'ffi' || value.kind === 'module') {
      const [name, member] = value.kind === 'module' ? [value.module, value.member] : ['ffi', ''];
      for (const read of ['m' + name, 'm*', 'u*', ...member.split('.').map(segment => 'u' + segment)]) run.reads.add(read);
      return replaced(name, member) ? UNKNOWN : value;
    }
    if (value.kind === 'library') {
      for (const id of value.ids) run.reads.add('l' + id);
      return value.ids.some(id => invalidLibraries.has(id)) ? UNKNOWN : value;
    }
    return value;
  };
  const summary = (binding: Binding): Value => {
    if (binding.volatile) return UNKNOWN;
    const writes = bindingWrites.get(binding.id);
    if (binding.kind === 'global' && !writes?.size) return UNKNOWN; // assigned in another file, if anywhere
    let value = BOTTOM;
    for (const write of writes?.values() ?? []) value = merge(value, write);
    return value;
  };
  const writesOutside = (binding: Binding, unit: number): Value => {
    let value = BOTTOM;
    for (const [writer, write] of bindingWrites.get(binding.id) ?? []) if (writer !== unit) value = merge(value, write);
    return value;
  };
  const read = (binding: Binding, run: Run): Value => {
    if (binding.volatile) return UNKNOWN;
    run.reads.add('b' + binding.id);
    const flow = run.state.get(binding.id);
    // Another function can run between any two statements once it exists.
    return flow !== undefined ? merge(flow, writesOutside(binding, run.unit.id)) : summary(binding);
  };
  const write = (binding: Binding, value: Value, run: Run): void => {
    const stored = binding.volatile ? UNKNOWN : scoped(value, binding.unit);
    // Any file can reach a global, and a parameter held outside its function outlives the call.
    if (binding.kind === 'global' || (stored.kind === 'unknown' && value.kind !== 'unknown')) escape(value, run);
    run.state.values.set(binding.id, stored);
    run.writes.set(binding.id, merge(run.writes.get(binding.id) ?? BOTTOM, stored));
  };
  const memberValue = (id: number, key: string): Value => {
    if (invalidTables.has(id) || (escaped.has(id) && (untracked.has(key) || untracked.has('*')))) return UNKNOWN;
    let value = NIL;
    for (const write of memberWrites.get(id)?.get(key)?.values() ?? []) value = merge(value, write);
    return value;
  };
  const readMember = (id: number, key: string, run: Run): Value => {
    for (const read of [`t${id}`, `t${id}:${key}`, `e${id}`, `u${key}`, 'u*']) run.reads.add(read);
    return memberValue(id, key);
  };
  const writeMember = (id: number, key: string, value: Value, run: Run): void => {
    // A value stored where code the analysis can't follow reaches goes with it.
    if (invalidTables.has(id)) surrender(value, run);
    else if (escaped.has(id)) escape(value, run);
    // Tables outlive the call that filled them, so a stored parameter is no longer one.
    if (value.kind === 'parameter' || value.kind === 'parameter_member') addEffect(value, '^');
    const members = run.members.get(id) ?? new Map<string, Value>();
    members.set(key, merge(members.get(key) ?? BOTTOM, scoped(value, undefined)));
    run.members.set(id, members);
  };
  const memberName = (n: SyntaxNode): string | undefined => {
    const memberNode = field(n, 'field') ?? field(n, 'method') ?? children(n)[1];
    return memberNode?.type === 'identifier' && n.type !== 'bracket_index_expression' ? memberNode.text : memberNode ? literal(memberNode) : undefined;
  };

  const valueOf = (n: SyntaxNode | undefined | null, run: Run): Value => {
    if (!n) return NIL;
    step();
    switch (n.type) {
      case 'identifier': {
        const binding = refs.get(n.startIndex);
        if (!binding) return UNKNOWN;
        if (binding.kind === 'global' && !binding.assigned && !binding.volatile && BUILTINS.has(binding.name)) return { kind: 'builtin', name: binding.name };
        return proven(read(binding, run), run);
      }
      case 'function_definition': return { kind: 'function', startIndex: n.startIndex };
      case 'nil': return NIL;
      case 'number': return { kind: 'number', value: n.text };
      case 'string': { const value = literal(n); return value === undefined ? UNKNOWN : { kind: 'string', value }; }
      case 'parenthesized_expression': return valueOf(children(n)[0], run);
      case 'binary_expression': {
        // `a or b` is one of them; `a and b` is `b`, or a false `a` no call goes through.
        const operator = n.children.find(child => !child.isNamed)?.type;
        if (operator === 'or') return merge(valueOf(field(n, 'left'), run), valueOf(field(n, 'right'), run));
        if (operator === 'and') { valueOf(field(n, 'left'), run); return valueOf(field(n, 'right'), run); }
        return UNKNOWN;
      }
      case 'table_constructor':
        for (const entry of children(n)) {
          const keyNode = field(entry, 'name');
          const bracketed = entry.children.some(c => c.type === '[');
          const key = keyNode?.type === 'identifier' && !bracketed ? keyNode.text : keyNode ? literal(keyNode) : undefined;
          const value = valueOf(field(entry, 'value'), run);
          if (key) { writeMember(n.startIndex, key, value, run); continue; }
          // A positional entry's integer key is no named member's; a computed key may be any.
          if (keyNode) invalidate(invalidTables, n.startIndex, 't' + n.startIndex);
          // Either way the value sits where the analysis can't name it.
          escape(value, run);
        }
        return { kind: 'table', id: n.startIndex };
      case 'dot_index_expression': case 'method_index_expression': case 'bracket_index_expression': {
        const receiver = proven(valueOf(field(n, 'table') ?? children(n)[0], run), run);
        if (receiver.kind === 'bottom') return BOTTOM;
        if (receiver.kind === 'parameter' || receiver.kind === 'parameter_member') {
          return { kind: 'parameter_member', index: receiver.index, owner: receiver.owner };
        }
        const member = memberName(n);
        if (!member) return UNKNOWN;
        if (receiver.kind === 'builtin') {
          const path = `${receiver.name}.${member}`;
          return BUILTIN_MEMBERS.has(path) ? { kind: 'builtin', name: path } : UNKNOWN;
        }
        if (receiver.kind === 'ffi' && member === 'C') return { kind: 'library', ids: [FFI_C] };
        if (receiver.kind === 'ffi' && member === 'load') return { kind: 'loader' };
        if (receiver.kind === 'library') return { kind: 'symbol', name: member };
        if (receiver.kind === 'table') return proven(readMember(receiver.id, member, run), run);
        if (receiver.kind === 'module') return proven({ ...receiver, member: receiver.member ? `${receiver.member}.${member}` : member }, run);
        return UNKNOWN;
      }
      case 'function_call': {
        const name = field(n, 'name');
        const args = argsOf(n);
        const callee = valueOf(name, run);
        if (callee.kind === 'bottom') return BOTTOM;
        if (isBuiltin(callee, 'require')) {
          const mod = args[0] ? literal(args[0]) : undefined;
          if (mod === 'ffi') return proven({ kind: 'ffi' }, run);
          if (mod) return proven({ kind: 'module', module: mod, member: '' }, run);
          return UNKNOWN;
        }
        // `assert(v, …)` returns `v`.
        if (isBuiltin(callee, 'assert')) return args.length ? valueOf(args[0], run) : NIL;
        if (callee.kind === 'loader') return { kind: 'library', ids: [n.startIndex] };
        // What a module's function returns is named by the call: whether it is a library, its module's analysis knows.
        if (callee.kind === 'module') return proven({ ...callee, member: `${callee.member}()` }, run);
        if (callee.kind === 'function' && returnsOf.has(callee.startIndex)) {
          run.reads.add('g' + callee.startIndex);
          return proven(returnsOf.get(callee.startIndex)!, run);
        }
        return UNKNOWN;
      }
      default: return UNKNOWN;
    }
  };
  const assignMember = (target: SyntaxNode, value: Value, run: Run): void => {
    const receiver = valueOf(field(target, 'table'), run);
    const member = memberName(target);
    if (receiver.kind === 'table') {
      // A known key joins that slot; an unknown key can overwrite any member.
      if (member) { writeMember(receiver.id, member, value, run); return; }
      invalidate(invalidTables, receiver.id, 't' + receiver.id);
      escape(value, run);
      return;
    }
    // Not yet known: a later run, which knows the receiver, places the write.
    if (receiver.kind === 'bottom' || receiver.kind === 'nil') return;
    escape(value, run);
    rewrite(receiver, member ?? '*', run);
    // A receiver the analysis can't resolve may be any table that has left its sight.
    if (!['module', 'ffi', 'library', 'builtin'].includes(receiver.kind)) invalidate(untracked, member ?? '*', 'u' + (member ?? '*'));
  };
  const assign = (n: SyntaxNode, run: Run): void => {
    const local = n.type === 'variable_declaration';
    const statement = local ? children(n).find(c => c.type === 'assignment_statement') ?? n : n;
    const vars = children(statement).find(c => c.type === 'variable_list');
    const exprs = children(statement).find(c => c.type === 'expression_list');
    const targets = vars ? children(vars).filter(c => c.type !== 'attribute') : [];
    const expressions = exprs ? children(exprs) : [];
    const values = expressions.map(e => valueOf(e, run));
    // A trailing call or vararg supplies every remaining target; those values are unknown.
    const last = expressions.at(-1);
    const remainder = last?.type === 'function_call' || last?.type === 'vararg_expression' ? UNKNOWN : NIL;
    // pcall returns its success flag, followed by ffi.load's library.
    const first = expressions[0];
    if (first?.type === 'function_call' && expressions.length === 1) {
      const callee = field(first, 'name');
      if (callee && isBuiltin(valueOf(callee, run), 'pcall') && valueOf(argsOf(first)[0], run).kind === 'loader') {
        values.splice(0, 1, UNKNOWN, { kind: 'library', ids: [first.startIndex] });
      }
    }
    expressions.forEach(e => visit(e, run));
    targets.forEach((target, i) => {
      const value = values[i] ?? remainder;
      if (target.type !== 'identifier') { assignMember(target, value, run); return; }
      const binding = (local ? decls : refs).get(target.startIndex);
      if (binding) write(binding, value, run);
    });
  };
  /** Join the bindings any outcome changed back into `into`, relative to `base`. */
  const joinOutcomes = (into: State, outcomes: State[], base: State, run: Run): boolean => {
    const keys = new Set<number>();
    for (const outcome of outcomes) for (let s: State | null = outcome; s && s !== base; s = s.parent) for (const key of s.values.keys()) keys.add(key);
    let changed = false;
    for (const key of keys) {
      const binding = bindings[key]!;
      const before = base.get(key);
      // A binding declared inside the construct is out of scope after it.
      if (before === undefined && binding.unit === run.unit.id) continue;
      const pre = before ?? summary(binding);
      let value = BOTTOM;
      for (const outcome of outcomes) value = merge(value, outcome.get(key) ?? pre);
      const previous = into.get(key);
      if (previous === undefined || !same(previous, value)) { into.values.set(key, value); changed = true; }
    }
    return changed;
  };
  const block = (node: SyntaxNode | null, run: Run): void => { if (node) for (const statement of children(node)) visit(statement, run); };
  const loop = (run: Run, body: () => void): void => {
    const parent = run.state;
    const head = new State(parent);
    const outer = run.log;
    let exits: State[] = [];
    let log = emptyLog();
    for (let iteration = 0; ; iteration++) {
      run.exits.push({ head, states: exits = [] });
      run.log = log = emptyLog();
      run.state = new State(head);
      body();
      run.exits.pop();
      const out = run.state;
      run.state = parent;
      // Zero or more iterations: the head joins its entry with every iteration's end.
      const changed = joinOutcomes(head, [head, out], head, run);
      if (!changed) break;
      if (iteration >= 8) {
        // Not converging: keep the changed bindings, but prove none of them.
        for (const key of head.values.keys()) head.values.set(key, UNKNOWN);
        run.exits.push({ head, states: exits = [] });
        run.log = log = emptyLog();
        run.state = new State(head);
        body();
        run.exits.pop();
        run.state = parent;
        break;
      }
    }
    // Only the converged iteration ran with the loop's final entry state.
    run.log = outer;
    outer.calls.push(...log.calls);
    outer.returns.push(...log.returns);
    outer.cdefs.push(...log.cdefs);
    joinOutcomes(parent, [head, ...exits], parent, run);
  };
  const visit = (n: SyntaxNode | null, run: Run): void => {
    if (!n) return;
    step();
    switch (n.type) {
      case 'comment': case 'ERROR': case 'goto_statement': case 'label_statement': return;
      case 'function_definition': return; // its body is a separate unit
      case 'function_declaration': {
        const name = field(n, 'name');
        const value: Value = { kind: 'function', startIndex: n.startIndex };
        if (name?.type === 'identifier') { const binding = decls.get(name.startIndex) ?? refs.get(name.startIndex); if (binding) write(binding, value, run); }
        else if (name) assignMember(name, value, run);
        return;
      }
      case 'variable_declaration': case 'assignment_statement': assign(n, run); return;
      case 'break_statement': {
        // Later statements keep writing to these layers; freeze what the break leaves with.
        const loop = run.exits.at(-1);
        if (!loop) return;
        const snapshot = new State(loop.head);
        for (let s: State | null = run.state; s && s !== loop.head; s = s.parent) {
          for (const [key, value] of s.values) if (!snapshot.values.has(key)) snapshot.values.set(key, value);
        }
        loop.states.push(snapshot);
        return;
      }
      case 'return_statement': {
        const list = children(n).find(c => c.type === 'expression_list');
        const expressions = list ? children(list) : [];
        // Evaluate on every pass: a returned table constructor defines its members.
        // The first value is what `local a, b = f()` gives `a`, and what `f().x` reads.
        const value = expressions.length ? valueOf(expressions[0], run) : NIL;
        run.log.returns.push({ value, unconditional: run.unit.id === CHUNK && n.parent?.type === 'chunk' });
        // What a function returns reaches callers the analysis does not follow; the chunk's, every file that requires it.
        expressions.forEach(e => escape(valueOf(e, run), run));
        expressions.forEach(e => visit(e, run));
        return;
      }
      case 'if_statement': {
        const parent = run.state;
        const outcomes: State[] = [];
        const arm = (condition: SyntaxNode | null, body: SyntaxNode | null): void => {
          visit(condition, run);
          run.state = new State(parent);
          block(body, run);
          outcomes.push(run.state);
          run.state = parent;
        };
        arm(field(n, 'condition'), field(n, 'consequence'));
        let otherwise = false;
        for (const alternative of children(n)) {
          if (alternative.type === 'elseif_statement') arm(field(alternative, 'condition'), field(alternative, 'consequence'));
          else if (alternative.type === 'else_statement') { arm(null, field(alternative, 'body')); otherwise = true; }
        }
        if (!otherwise) outcomes.push(new State(parent));
        joinOutcomes(parent, outcomes, parent, run);
        return;
      }
      case 'while_statement': loop(run, () => { visit(field(n, 'condition'), run); block(field(n, 'body'), run); }); return;
      case 'repeat_statement': loop(run, () => { block(field(n, 'body'), run); visit(field(n, 'condition'), run); }); return;
      case 'for_statement': {
        const clause = field(n, 'clause');
        let names: SyntaxNode[] = [];
        if (clause?.type === 'for_numeric_clause') {
          visit(field(clause, 'start'), run); visit(field(clause, 'end'), run); visit(field(clause, 'step'), run);
          names = [field(clause, 'name')].filter((v): v is SyntaxNode => v !== null);
        } else if (clause) {
          visit(children(clause).find(c => c.type === 'expression_list') ?? null, run);
          names = children(children(clause).find(c => c.type === 'variable_list') ?? clause).filter(c => c.type === 'identifier');
        }
        loop(run, () => {
          for (const name of names) { const binding = decls.get(name.startIndex); if (binding) write(binding, UNKNOWN, run); }
          block(field(n, 'body'), run);
        });
        return;
      }
      case 'do_statement': block(field(n, 'body'), run); return;
      case 'block': block(n, run); return;
      case 'function_call': {
        const name = field(n, 'name');
        if (name) {
          const value = valueOf(name, run);
          // `a:b(…)` hands `a` over too. A callee not yet known is placed by a later run.
          const receiver = name.type === 'method_index_expression' ? field(name, 'table') : null;
          if (value.kind !== 'bottom' && value.kind !== 'nil') pass(value, [...(receiver ? [valueOf(receiver, run)] : []), ...argsOf(n).map(arg => valueOf(arg, run))], run);
          if (name.type === 'dot_index_expression' && memberName(name) === 'cdef' && valueOf(field(name, 'table'), run).kind === 'ffi') {
            const text = argsOf(n)[0] && literal(argsOf(n)[0]!);
            if (text !== undefined) run.log.cdefs.push(...cdefFunctions(text));
          }
          run.log.calls.push({ callee: name.text, startIndex: n.startIndex, endIndex: n.endIndex,
            line: n.startPosition.row + 1, column: n.startPosition.column,
            ...(value.kind === 'symbol' ? { ffiSymbol: value.name } : {}),
            ...(value.kind === 'module' ? { resolvedCallee: value.member, importedModule: value.module } : {}),
            ...(run.unit.id === CHUNK ? {} : { functionStartIndex: run.unit.id }) });
        }
        for (const child of children(n)) visit(child, run);
        return;
      }
      case 'table_constructor':
        for (const entry of children(n)) {
          if (entry.children.some(c => c.type === '[')) visit(field(entry, 'name'), run);
          visit(field(entry, 'value'), run);
        }
        return;
      default: for (const child of children(n)) visit(child, run);
    }
  };

  const analyze = (unit: Unit): Run => {
    const run: Run = { unit, state: new State(null), log: emptyLog(), writes: new Map(), members: new Map(), reads: new Set(), exits: [] };
    current = run;
    unit.params.forEach((binding, index) => write(binding, { kind: 'parameter', index, owner: unit.id }, run));
    if (unit.id === CHUNK) { block(unit.node, run); return run; }
    block(field(unit.node, 'body'), run);
    // A function that returns nothing, or something other than a namespace, proves no receiver at its call sites.
    let returned: Value = run.log.returns.length ? BOTTOM : NIL;
    for (const { value } of run.log.returns) returned = join(returned, value);
    run.returned = returned.kind === 'module' || returned.kind === 'ffi' || returned.kind === 'library' || returned.kind === 'bottom' ? returned : UNKNOWN;
    return run;
  };

  // Facts only grow toward unknown, so a dependency worklist reaches a fixed point.
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const dependents = new Map<string, Set<number>>();
  const queue: number[] = units.map(unit => unit.id);
  const queued = new Set(queue);
  const wake = (key: string): void => {
    for (const id of dependents.get(key) ?? []) if (!queued.has(id)) { queued.add(id); queue.push(id); }
  };
  let budget = units.length * 50 + 1000;
  const settle = (): boolean => {
    while (queue.length) {
      if (--budget < 0) return false;
      const id = queue.shift()!;
      queued.delete(id);
      changed.length = 0;
      const run = analyze(byId.get(id)!);
      logs.set(id, run.log);
      for (const key of run.reads) { const readers = dependents.get(key) ?? new Set<number>(); readers.add(id); dependents.set(key, readers); }
      for (const [binding, value] of run.writes) {
        const writes = bindingWrites.get(binding) ?? new Map<number, Value>();
        const previous = writes.get(id);
        if (previous && same(previous, value)) continue;
        writes.set(id, value); bindingWrites.set(binding, writes);
        wake('b' + binding);
      }
      for (const [table, members] of run.members) {
        const keys = memberWrites.get(table) ?? new Map<string, Map<number, Value>>();
        memberWrites.set(table, keys);
        for (const [key, value] of members) {
          const writes = keys.get(key) ?? new Map<number, Value>();
          const previous = writes.get(id);
          if (previous && same(previous, value)) continue;
          writes.set(id, value); keys.set(key, writes);
          wake(`t${table}:${key}`);
        }
      }
      if (run.returned && !same(returnsOf.get(id)!, run.returned)) {
        returnsOf.set(id, run.returned);
        wake('g' + id);
      }
      changed.forEach(wake);
    }
    return true;
  };
  if (!settle()) return null;
  // A return that never settled (e.g. mutual recursion) proves nothing.
  for (const [id, value] of returnsOf) if (value.kind === 'bottom') { returnsOf.set(id, UNKNOWN); wake('g' + id); }
  if (!settle()) return null;
  current = undefined;

  for (const unit of units) {
    const log = logs.get(unit.id)!;
    result.calls.push(...log.calls);
    for (const [declared, symbol] of log.cdefs) {
      const symbols = result.cdefSymbols[declared] ??= [];
      if (!symbols.includes(symbol)) symbols.push(symbol);
    }
    if (unit.id === CHUNK) continue;
    const node = unit.node;
    result.functions.push({ name: unit.name, startIndex: node.startIndex, endIndex: node.endIndex, line: node.startPosition.row + 1,
      column: node.startPosition.column, endLine: node.endPosition.row + 1,
      ...(unit.parent === CHUNK ? {} : { parentStartIndex: unit.parent }) });
  }
  const moduleReturns = logs.get(CHUNK)!.returns;
  if (moduleReturns.length === 1 && moduleReturns[0]!.unconditional) {
    const library = (value: Value | undefined): boolean => value?.kind === 'library' && !value.ids.some(id => invalidLibraries.has(id));
    const collect = (value: Value, prefix: string, seen: Set<number>): void => {
      if (library(value)) result.exportedLibraries.push(prefix);
      if (value.kind === 'function') {
        if (library(returnsOf.get(value.startIndex))) result.exportedLoaders.push(prefix);
      } else if (value.kind === 'table' && !seen.has(value.id)) {
        const next = new Set(seen).add(value.id);
        for (const key of memberWrites.get(value.id)?.keys() ?? []) collect(memberValue(value.id, key), prefix ? `${prefix}.${key}` : key, next);
      }
    };
    collect(moduleReturns[0]!.value, '', new Set());
  }
  result.calls.sort((a, b) => a.startIndex - b.startIndex);
  result.functions.sort((a, b) => a.startIndex - b.startIndex);
  return result;
}
