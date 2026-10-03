/**
 * Static source guard (all platforms): every child process spawned from `src/`
 * sets `windowsHide: true`.
 *
 * The MCP daemon is spawned detached and has no console of its own. On
 * Windows, a console program (git, …) it starts without windowsHide gets a
 * brand-new visible console, so a terminal window flashes on screen and closes
 * once per call: on daemon start and again on every auto-sync (#485, #928,
 * #1092, #2094, #2096, #2312). With Windows Terminal set as the default
 * terminal, each flash is a full Windows Terminal window.
 *
 * windowsHide is Windows-only behavior the POSIX test runs can't observe, so it
 * is asserted on the TypeScript AST. Options passed through a variable or a
 * function parameter are traced back to the object literal that defines them
 * (for a parameter: through every call site of that function in the file).
 *
 * The guard fails closed: a spawn it can't trace is an offender, not a pass.
 * That covers child_process reached any way other than a static import
 * (`require`, `import()`, a re-export), a spawner used as a value instead of
 * called (`const run = execFileSync`, `promisify(execFile)`, `const { spawn } =
 * cp`), options in a `let`, and an options parameter of an exported function
 * (its callers in other files are out of sight). The second `describe` pins
 * each of those shapes so the guard itself can't silently go blind.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const SRC_DIR = path.join(__dirname, '..', 'src');

/**
 * child_process functions that start a process and accept `windowsHide`, by
 * argument shape: `file` is `(file, args?, options?)`, `command` is
 * `(command, options?)`.
 */
const SPAWNERS: Record<string, 'file' | 'command'> = {
  exec: 'command',
  execSync: 'command',
  execFile: 'file',
  execFileSync: 'file',
  spawn: 'file',
  spawnSync: 'file',
  fork: 'file',
};

const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);

/**
 * Spawns that intentionally run without windowsHide, keyed by
 * `<path relative to src>:<spawner>(<command>)`, valued by the reason.
 */
const ALLOWED: Record<string, string> = {
  "resolution/memory-budget.ts:execFileSync('/usr/bin/vm_stat')": 'macOS only: guarded by process.platform === darwin',
  'ui-server/open-browser.ts:spawn(open.command)':
    'detached: true maps to DETACHED_PROCESS on Windows, so `cmd /c start` gets no console to show',
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function isChildProcessModule(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isStringLiteralLike(node) && CHILD_PROCESS_MODULES.has(node.text);
}

/** Local names bound to child_process exports in one file. */
interface ChildProcessBindings {
  /** Local name → imported child_process export (`import { spawn as s }`). */
  named: Map<string, string>;
  /**
   * Names bound to the module object: `import * as cp`, `import cp` (with
   * esModuleInterop) and `import cp = require(…)`.
   */
  namespaces: Set<string>;
}

function childProcessBindings(sf: ts.SourceFile): ChildProcessBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isImportEqualsDeclaration(stmt)) {
      const ref = stmt.moduleReference;
      if (ts.isExternalModuleReference(ref) && isChildProcessModule(ref.expression)) namespaces.add(stmt.name.text);
      continue;
    }
    if (!ts.isImportDeclaration(stmt) || !isChildProcessModule(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause) continue; // bare `import 'child_process'` binds nothing
    if (clause.name) namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else for (const el of bindings.elements) named.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  return { named, namespaces };
}

/** The child_process function a call invokes, or null when it isn't one. */
function spawnerOf(call: ts.CallExpression, b: ChildProcessBindings): string | null {
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? b.named.get(callee.text)
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && b.namespaces.has(callee.expression.text)
      ? callee.name.text
      : undefined;
  return name !== undefined && Object.hasOwn(SPAWNERS, name) ? name : null;
}

/** The options argument of a spawner call, or undefined when none is passed. */
function optionsArg(call: ts.CallExpression, spawner: string): ts.Expression | undefined {
  const [, second, third] = call.arguments;
  if (SPAWNERS[spawner] === 'command') return second;
  // (file, options) is allowed when the args array is omitted.
  if (second && ts.isObjectLiteralExpression(second)) return second;
  return third;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

function isCallee(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

/**
 * True when `id` reads the binding it names as a value. False for a type
 * position (`typeof execFileSync`), and for an identifier that only names a
 * declaration or a member: `x.exec`, `{ exec: … }`, `const spawn = …`, the
 * import specifier itself. A re-export (`export { spawn }`) and a shorthand
 * property (`{ spawn }`) DO read the value.
 */
function isValueReference(id: ts.Identifier): boolean {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) if (ts.isTypeNode(n)) return false;
  const p = id.parent as ts.Node & { name?: ts.Node; propertyName?: ts.Node };
  if (ts.isShorthandPropertyAssignment(p) || ts.isExportSpecifier(p)) return true;
  if (p.name === id || p.propertyName === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  return true;
}

/** Variable initializer or function parameter that `name` refers to at `from`. */
function resolveBinding(name: string, from: ts.Node): ts.VariableDeclaration | ts.ParameterDeclaration | null {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const param = scope.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (param) return param;
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      for (const stmt of scope.statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        const decl = stmt.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
        if (decl) return decl;
      }
    }
  }
  return null;
}

/**
 * The argument every call of the function that declares `param` passes for it
 * (undefined where a call omits it), found by name in the same file. Null when
 * the callers can't all be seen: the function is unnamed, exported (callers in
 * other files), or used as a value (a callback receives whatever its caller
 * passes).
 */
function callSitesOf(param: ts.ParameterDeclaration, sf: ts.SourceFile): (ts.Expression | undefined)[] | null {
  const fn = param.parent;
  if (!ts.isFunctionDeclaration(fn) || !fn.name) return null;
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return null;
  const fnName = fn.name.text;
  const index = fn.parameters.indexOf(param);
  const args: (ts.Expression | undefined)[] = [];
  let usedAsValue = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === fnName && node !== fn.name && isValueReference(node)) {
      if (!isCallee(node)) usedAsValue = true;
      else {
        const call = node.parent as ts.CallExpression;
        // A spread before the parameter's slot hides which value lands in it.
        if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) usedAsValue = true;
        else args.push(call.arguments[index]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return usedAsValue || args.length === 0 ? null : args;
}

/**
 * What options `expr` evaluates to do with windowsHide: provably set to true
 * (`hidden`), provably not set at all (`absent`, e.g. no options passed, or a
 * spread of `{ cwd }`), or anything else (`unhidden`: false, a non-literal, or
 * unknowable). `absent` matters for spreads: `{ windowsHide: true, ...extra }`
 * stays hidden only when `extra` provably doesn't set it back.
 */
type HideState = 'hidden' | 'absent' | 'unhidden';

function hideState(expr: ts.Expression | undefined, sf: ts.SourceFile, seen = new Set<ts.Node>()): HideState {
  if (!expr) return 'absent';
  const e = unwrap(expr);
  if (seen.has(e)) return 'unhidden'; // a cycle proves nothing
  // Path-local: two call sites passing the same options object both resolve.
  const trail = new Set(seen).add(e);
  if (ts.isObjectLiteralExpression(e)) {
    let state: HideState = 'absent';
    for (const prop of e.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'windowsHide') {
        state = unwrap(prop.initializer).kind === ts.SyntaxKind.TrueKeyword ? 'hidden' : 'unhidden';
      } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'windowsHide') {
        state = 'unhidden'; // not provable statically
      } else if (ts.isSpreadAssignment(prop)) {
        const spread = hideState(prop.expression, sf, trail);
        if (spread !== 'absent') state = spread;
      }
    }
    return state; // last write wins, matching object-literal semantics
  }
  if (ts.isIdentifier(e)) {
    const binding = resolveBinding(e.text, e);
    if (!binding) return 'unhidden';
    if (ts.isVariableDeclaration(binding)) {
      // A `let` or `var` can be reassigned after its initializer.
      const list = binding.parent;
      if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return 'unhidden';
      return binding.initializer ? hideState(binding.initializer, sf, trail) : 'unhidden';
    }
    const sites = callSitesOf(binding, sf);
    if (sites === null) return 'unhidden';
    const states = new Set(sites.map((arg) => hideState(arg, sf, trail)));
    return states.size === 1 ? [...states][0] : 'unhidden';
  }
  return 'unhidden';
}

/** True when `expr` provably evaluates to options with `windowsHide: true`. */
function hidesWindow(expr: ts.Expression | undefined, sf: ts.SourceFile): boolean {
  return hideState(expr, sf) === 'hidden';
}

function commandLabel(call: ts.CallExpression, sf: ts.SourceFile): string {
  const first = call.arguments[0];
  if (!first) return '';
  if (ts.isStringLiteralLike(first)) return `'${first.text}'`;
  return first.getText(sf);
}

/** Every spawn in one file, and each one that isn't provably hidden. */
function scanSource(rel: string, text: string): { seen: number; offenders: string[] } {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = childProcessBindings(sf);
  const offenders: string[] = [];
  let seen = 0;
  const flag = (node: ts.Node, what: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    offenders.push(`${rel}:${line + 1} ${what}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && isChildProcessModule(node.moduleSpecifier)) {
      flag(node, 're-exports child_process: spawns through the re-export are out of sight');
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        (ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword;
      if (loads && isChildProcessModule(node.arguments[0])) {
        flag(node, `${callee.getText(sf)}(child_process): import it statically so its spawns can be checked`);
      }
      const spawner = spawnerOf(node, bindings);
      if (spawner) {
        seen++;
        const key = `${rel}:${spawner}(${commandLabel(node, sf)})`;
        if (!Object.hasOwn(ALLOWED, key) && !hidesWindow(optionsArg(node, spawner), sf)) flag(node, key);
      }
    }
    const bound = ts.isIdentifier(node) && (bindings.named.has(node.text) || bindings.namespaces.has(node.text));
    if (bound && isValueReference(node)) {
      const imported = bindings.named.get(node.text);
      if (imported !== undefined && Object.hasOwn(SPAWNERS, imported) && !isCallee(node)) {
        flag(node, `${node.text} used as a value: call it directly so its options can be checked`);
      } else if (bindings.namespaces.has(node.text)) {
        const member = node.parent;
        const direct =
          ts.isPropertyAccessExpression(member) &&
          member.expression === node &&
          (!Object.hasOwn(SPAWNERS, member.name.text) || isCallee(member));
        if (!direct) flag(node, `${node.getText(sf)} used as a value: call its spawners directly so their options can be checked`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { seen, offenders };
}

describe('child processes set windowsHide (#1092, #2094, #2312)', () => {
  it('every child_process spawn under src/ sets windowsHide: true', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of listSourceFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
      const result = scanSource(rel, fs.readFileSync(file, 'utf8'));
      seen += result.seen;
      offenders.push(...result.offenders);
    }
    expect(seen).toBeGreaterThan(0); // guard against a false pass if the imports move
    expect(offenders, `spawned without windowsHide:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('the windowsHide guard fails closed', () => {
  const scan = (text: string) => scanSource('fixture.ts', text);

  it.each([
    [
      'the core.excludesFile read the watcher repeats (#2312)',
      `import { execFileSync } from 'child_process';
       execFileSync('git', ['-C', root, 'config', '--get', 'core.excludesFile'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });`,
    ],
    ['windowsHide: false', `import { spawn } from 'child_process'; spawn('git', [], { windowsHide: false });`],
    ['a later spread overriding it', `import { spawn } from 'child_process'; spawn('git', [], { windowsHide: true, ...{ windowsHide: false } });`],
    ['a later spread that might override it', `import { spawn } from 'child_process'; spawn('git', [], { windowsHide: true, ...extra() });`],
    ['a default import', `import cp from 'child_process'; cp.execFileSync('git', ['status'], { encoding: 'utf8' });`],
    ['an import-equals', `import cp = require('child_process'); cp.spawnSync('git', ['status']);`],
    ['a require()', `const { execFileSync } = require('child_process'); execFileSync('git', ['status'], { windowsHide: true });`],
    ['a dynamic import()', `async function f() { const cp = await import('node:child_process'); }`],
    ['a re-export', `export { spawn } from 'child_process';`],
    ['a re-export of the import', `import { spawn } from 'child_process'; export { spawn };`],
    ['an alias', `import { execFileSync } from 'child_process'; const run = execFileSync; run('git', ['status']);`],
    ['promisify', `import { execFile } from 'child_process'; import { promisify } from 'util'; const run = promisify(execFile);`],
    ['a shorthand property', `import { spawn } from 'child_process'; const deps = { spawn };`],
    ['a destructured namespace', `import * as cp from 'child_process'; const { spawn } = cp; spawn('git', []);`],
    ['a namespace spawner as a value', `import * as cp from 'child_process'; [].forEach(cp.spawn);`],
    [
      'options in a let',
      `import { execFileSync } from 'child_process';
       let opts = { windowsHide: true }; opts = {}; execFileSync('git', [], opts);`,
    ],
    [
      'an exported wrapper (its callers elsewhere are out of sight)',
      `import { execFileSync } from 'child_process';
       export function git(args: string[], opts: object) { return execFileSync('git', args, opts); }
       git(['status'], { windowsHide: true });`,
    ],
    [
      'a wrapper call that omits the options',
      `import { execFileSync } from 'child_process';
       function git(args: string[], opts?: object) { return execFileSync('git', args, opts); }
       git(['status'], { windowsHide: true }); git(['log']);`,
    ],
    [
      'a wrapper passed as a callback',
      `import { execFileSync } from 'child_process';
       function git(opts: object) { return execFileSync('git', [], opts); }
       git({ windowsHide: true }); [{}].map(git);`,
    ],
  ])('flags %s', (_label, text) => {
    expect(scan(text).offenders).not.toEqual([]);
  });

  it.each([
    ['a literal', `import { execFileSync } from 'child_process'; execFileSync('git', ['status'], { windowsHide: true });`],
    ['(file, options)', `import { execFileSync } from 'child_process'; execFileSync('git', { windowsHide: true });`],
    ['a command spawner', `import { exec } from 'child_process'; exec('git status', { windowsHide: true }); /a/.exec('a');`],
    ['a const', `import { spawn } from 'child_process'; const o = { windowsHide: true }; spawn('git', [], o);`],
    ['a spread const', `import { spawn } from 'child_process'; const base = { windowsHide: true }; spawn('git', [], { ...base, cwd: '.' });`],
    ['a later spread that leaves it alone', `import { spawn } from 'child_process'; const extra = { cwd: '.' }; spawn('git', [], { windowsHide: true, ...extra });`],
    ['a namespace', `import * as cp from 'node:child_process'; let c: cp.ChildProcess | undefined; cp.spawn('git', [], { windowsHide: true });`],
    [
      'a wrapper whose every call passes the same hidden options',
      `import { execFileSync } from 'child_process';
       function git(opts: Parameters<typeof execFileSync>[2]) { return execFileSync('git', [], opts); }
       const gitOpts = { cwd: '.', windowsHide: true };
       git(gitOpts); git(gitOpts);`,
    ],
    ['types only', `import type { ChildProcess } from 'child_process'; let c: ChildProcess | undefined;`],
  ])('passes %s', (_label, text) => {
    expect(scan(text).offenders).toEqual([]);
  });
});
