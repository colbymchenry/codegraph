/**
 * Static source guard (all platforms): every child process spawned from `src/`
 * sets `windowsHide: true`.
 *
 * The MCP daemon is spawned detached and has no console of its own. On
 * Windows, a console program (git, …) it starts without windowsHide gets a
 * brand-new visible console, so a terminal window flashes on screen and closes
 * once per call: on daemon start and again on every auto-sync (#485, #928,
 * #1092, #2094, #2096). With Windows Terminal set as the default terminal, each
 * flash is a full Windows Terminal window.
 *
 * windowsHide is Windows-only behavior the POSIX test runs can't observe, so it
 * is asserted on the TypeScript AST. Options passed through a variable or a
 * function parameter are traced back to the object literal that defines them
 * (for a parameter: through every call site of that function in the file).
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

/** Local names bound to child_process exports in one file. */
interface ChildProcessBindings {
  /** Local name → imported child_process export (`import { spawn as s }`). */
  named: Map<string, string>;
  /** Namespace aliases (`import * as cp from 'child_process'`). */
  namespaces: Set<string>;
}

function childProcessBindings(sf: ts.SourceFile): ChildProcessBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!['child_process', 'node:child_process'].includes(stmt.moduleSpecifier.text)) continue;
    const bindings = stmt.importClause?.namedBindings;
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

/** Calls to the function that declares `param`, found by name in the same file. */
function callSitesOf(param: ts.ParameterDeclaration, sf: ts.SourceFile): ts.Expression[] | null {
  const fn = param.parent;
  const fnName = ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text : null;
  if (!fnName) return null;
  const index = fn.parameters.indexOf(param);
  const args: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === fnName) {
      const arg = node.arguments[index];
      if (arg) args.push(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return args.length > 0 ? args : null;
}

/** True when `expr` provably evaluates to options with `windowsHide: true`. */
function hidesWindow(expr: ts.Expression | undefined, sf: ts.SourceFile, seen = new Set<ts.Node>()): boolean {
  if (!expr) return false;
  const e = unwrap(expr);
  if (seen.has(e)) return false;
  seen.add(e);
  if (ts.isObjectLiteralExpression(e)) {
    let hidden = false;
    for (const prop of e.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name.getText(sf) === 'windowsHide') {
        hidden = unwrap(prop.initializer).kind === ts.SyntaxKind.TrueKeyword;
      } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'windowsHide') {
        hidden = false; // not provable statically
      } else if (ts.isSpreadAssignment(prop) && hidesWindow(prop.expression, sf, seen)) {
        hidden = true;
      }
    }
    return hidden; // last write wins, matching object-literal semantics
  }
  if (ts.isIdentifier(e)) {
    const binding = resolveBinding(e.text, e);
    if (!binding) return false;
    if (ts.isVariableDeclaration(binding)) return hidesWindow(binding.initializer, sf, seen);
    const sites = callSitesOf(binding, sf);
    return sites !== null && sites.every((arg) => hidesWindow(arg, sf, seen));
  }
  return false;
}

function commandLabel(call: ts.CallExpression, sf: ts.SourceFile): string {
  const first = call.arguments[0];
  if (!first) return '';
  if (ts.isStringLiteralLike(first)) return `'${first.text}'`;
  return first.getText(sf);
}

describe('child processes set windowsHide (#1092, #2094)', () => {
  it('every child_process spawn under src/ sets windowsHide: true', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of listSourceFiles(SRC_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const bindings = childProcessBindings(sf);
      if (bindings.named.size === 0 && bindings.namespaces.size === 0) continue;
      const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const spawner = spawnerOf(node, bindings);
          if (spawner) {
            seen++;
            const key = `${rel}:${spawner}(${commandLabel(node, sf)})`;
            if (!Object.hasOwn(ALLOWED, key) && !hidesWindow(optionsArg(node, spawner), sf)) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              offenders.push(`${rel}:${line + 1} ${key}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(seen).toBeGreaterThan(0); // guard against a false pass if the imports move
    expect(offenders, `spawned without windowsHide:\n${offenders.join('\n')}`).toEqual([]);
  });
});
