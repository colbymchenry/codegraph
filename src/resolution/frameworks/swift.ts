/**
 * Swift Framework Resolver
 *
 * Handles SwiftUI, UIKit, and Vapor (server-side Swift) patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { pickByNameAndKind } from './name-heuristic';

// No extract(): a SwiftUI view is its own struct node, and a UIKit controller
// its class. A one-line `component`/`class` twin per `struct X: View` (and per
// `@main` app, view controller and UIView subclass) carried no edges and
// showed up in search and the symbol view as a dead-end duplicate.
export const swiftUIResolver: FrameworkResolver = {
  name: 'swiftui',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    // Check for SwiftUI imports in Swift files
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import SwiftUI')) {
          return true;
        }
      }
    }

    // Check for Xcode project with SwiftUI
    for (const file of allFiles) {
      if (file.endsWith('.xcodeproj') || file.endsWith('.xcworkspace')) {
        return true;
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Swift's conventions, for Swift's refs: an Objective-C `@interface SDDiskCache
    // : NSObject <SDDiskCache>` is no SwiftUI view or model.
    if (ref.language !== 'swift') return null;
    // Pattern 1: View references (SwiftUI views are PascalCase ending in View)
    if (ref.referenceName.endsWith('View') && /^[A-Z]/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref, VIEW_KINDS, VIEW_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: ViewModel/ObservableObject references
    if (ref.referenceName.endsWith('ViewModel') || ref.referenceName.endsWith('Store') || ref.referenceName.endsWith('Manager')) {
      const result = resolveByNameAndKind(ref, CLASS_KINDS, VIEWMODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Model references
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref, MODEL_KINDS, MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },
};

export const uikitResolver: FrameworkResolver = {
  name: 'uikit',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('import UIKit') ||
          content.includes('UIViewController') ||
          content.includes('UIView')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Swift's conventions, for Swift's refs: an Objective-C `@interface SDDiskCache
    // : NSObject <SDDiskCache>` is no SwiftUI view or model.
    if (ref.language !== 'swift') return null;
    // Pattern 1: ViewController references
    if (ref.referenceName.endsWith('ViewController')) {
      const result = resolveByNameAndKind(ref, CLASS_KINDS, VC_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: UIView subclass references
    if (ref.referenceName.endsWith('View') && !ref.referenceName.endsWith('ViewController')) {
      const result = resolveByNameAndKind(ref, CLASS_KINDS, UIVIEW_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Cell references
    if (ref.referenceName.endsWith('Cell')) {
      const result = resolveByNameAndKind(ref, CLASS_KINDS, CELL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Delegate/DataSource references
    if (ref.referenceName.endsWith('Delegate') || ref.referenceName.endsWith('DataSource')) {
      const result = resolveByNameAndKind(ref, PROTOCOL_KINDS, [], context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },
};

export const vaporResolver: FrameworkResolver = {
  name: 'vapor',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    // Check for Package.swift with Vapor dependency
    const packageSwift = context.readFile('Package.swift');
    if (packageSwift && packageSwift.includes('vapor')) {
      return true;
    }

    // Check for Vapor imports
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import Vapor')) {
          return true;
        }
      }
    }

    return false;
  },

  // A route's handler ref (`SearchController@show`, `@index`) names no declared
  // symbol, so resolveOne's pre-filter would drop it before resolve() runs.
  claimsReference(name: string): boolean {
    return VAPOR_HANDLER.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Swift's conventions, for Swift's refs: an Objective-C `@interface SDDiskCache
    // : NSObject <SDDiskCache>` is no SwiftUI view or model.
    if (ref.language !== 'swift') return null;
    // Pattern 0: a route's handler — `use: SearchController.show` arrives as
    // `SearchController@show`, `use: self.index` / `use: index` as `@index`.
    // Resolved on the type the route names, never by the method's name alone:
    // every controller has a `show`. No match, or two, is left unresolved.
    const handler = VAPOR_HANDLER.exec(ref.referenceName);
    if (handler) {
      const target = resolveVaporHandler(handler[1] ?? null, handler[2]!, ref, context);
      return target ? { original: ref, targetNodeId: target, confidence: 0.9, resolvedBy: 'framework' } : null;
    }

    // Pattern 1: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref, VAPOR_CONTROLLER_KINDS, VAPOR_CONTROLLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Model references (Fluent)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref, CLASS_KINDS, FLUENT_MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Middleware references
    if (ref.referenceName.endsWith('Middleware')) {
      const result = resolveByNameAndKind(ref, VAPOR_CONTROLLER_KINDS, VAPOR_MIDDLEWARE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'swift');

    // Build a group-var → path-prefix map first. Modern Vapor routes live on a
    // grouped builder (`let todos = routes.grouped("todos"); todos.get(use: index)`
    // or `routes.group("todos") { todos in todos.get(use: index) }`), so the path
    // comes from the group, not the call. Roots (app/routes/router) have no prefix.
    const groupPrefix = new Map<string, string>();
    const segJoin = (existing: string, segsStr: string): string => {
      const segs = (segsStr.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1));
      return existing + segs.map((s) => '/' + s).join('');
    };
    let gm: RegExpExecArray | null;
    // let X = Y.grouped("a", "b")
    const groupedRegex = /\blet\s+(\w+)\s*=\s*(\w+)\.grouped\s*\(([^)]*)\)/g;
    while ((gm = groupedRegex.exec(safe)) !== null) {
      groupPrefix.set(gm[1]!, segJoin(groupPrefix.get(gm[2]!) ?? '', gm[3]!));
    }
    // Y.group("a") { X in ... }
    const groupClosureRegex = /\b(\w+)\.group\s*\(([^)]*)\)\s*\{\s*(\w+)\s+in/g;
    while ((gm = groupClosureRegex.exec(safe)) !== null) {
      groupPrefix.set(gm[3]!, segJoin(groupPrefix.get(gm[1]!) ?? '', gm[2]!));
    }

    // Vapor: <builder>.METHOD([path segs,] use: handler). Any receiver (app,
    // routes, or a grouped var); path segments optional and may be non-string
    // (`BlogUser.parameter`, `:id`, a path constant) so accept any comma-separated
    // args before `use:` — the label keeps only the string parts. `use:`
    // discriminates a real route from Environment.get("X")/req.parameters.get("X").
    // Each arg repetition must end at a comma, and `,` is outside the char class,
    // so the split is unique and matching stays linear. The earlier
    // `(?:[^,()]+,\s*)*` was ambiguous — the trailing `\s*` and the next
    // iteration's `[^,()]+` could both claim the same spaces — which backtracked
    // exponentially on a long arg list that never reaches `use:`.
    // The tail is `\s*` rather than a lazy `[^,()]*?` on purpose: both are
    // linear, but the lazy form drops the "`use:` is preceded by a comma"
    // requirement and widens the match set — `req.get(foo.use: bar)` would then
    // be indexed as a route (groups `["req","get","foo.","bar"]`) where both
    // this pattern and the original match nothing.
    const routeRegex = /\b(\w+)\.(get|post|put|patch|delete|head|options)\s*\(\s*((?:[^,()]+,)*\s*)use:\s*([A-Za-z_][\w.]*)/g;
    // `let todos = TodoController()` — what a `use: todos.index` receiver is.
    const receiverTypes = new Map<string, string>();
    const receiverRegex = /\b(?:let|var)\s+([a-z_]\w*)\s*(?::\s*([A-Z]\w*)\s*)?=\s*([A-Z][\w.]*)\s*\(/g;
    while ((gm = receiverRegex.exec(safe)) !== null) receiverTypes.set(gm[1]!, gm[2] ?? gm[3]!);
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, receiver, method, segsStr, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const upper = method!.toUpperCase();
      const routePath = (groupPrefix.get(receiver!) ?? '') + segJoin('', segsStr!) || '/';

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handlerName = vaporHandlerRef(handlerExpr!, receiverTypes);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'swift',
        });
      }
    }

    // `routes.on(.POST, "x", use: handler)` names its method as the first argument.
    // Arguments may hold one level of parentheses (`body: .collect(maxSize: "1mb")`);
    // only unlabeled string arguments are path segments.
    const onRegex = /\b(\w+)\.on\s*\(\s*\.([A-Z]+)\s*,\s*((?:(?:[^,()]|\([^()]*\))+,)*\s*)use:\s*([A-Za-z_][\w.]*)/g;
    const pathArgs = (argText: string) => argText.split(',').filter((a) => /^\s*"[^"]*"\s*$/.test(a)).join(',');
    while ((match = onRegex.exec(safe)) !== null) {
      const [, receiver, method, segsStr, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const routePath = (groupPrefix.get(receiver!) ?? '') + segJoin('', pathArgs(segsStr!)) || '/';
      const id = `route:${filePath}:${line}:${method}:${routePath}`;
      nodes.push({
        id, kind: 'route', name: `${method} ${routePath}`, qualifiedName: `${filePath}::route:${routePath}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: 'swift', updatedAt: now,
      });
      const handlerName = vaporHandlerRef(handlerExpr!, receiverTypes);
      if (handlerName) references.push({ fromNodeId: id, referenceName: handlerName, referenceKind: 'references', line, column: 0, filePath, language: 'swift' });
    }

    // A route whose handler is a trailing closure — `app.get("hello") { req in … }`,
    // `app.webSocket("chat") { req, ws in … }`, `routes.on(.GET, "x") { … }`. It has
    // no handler symbol; the closure's calls belong to the function registering it.
    // An HTTP client's `req.client.get("https://…") { … }` is not a route.
    const closureRegex = /\b(\w+)\.(get|post|put|patch|delete|head|options|webSocket|on)\s*\(([^()]*)\)\s*\{/g;
    while ((match = closureRegex.exec(safe)) !== null) {
      const [, receiver, verb, args] = match;
      if (/\buse:/.test(args!) || receiver === 'client' || /^\s*"https?:/.test(args!)) continue;
      // A route registration is a statement: `if let v = req.parameters.get("x") {`
      // opens the `if` body, not a trailing closure.
      const lineStart = safe.lastIndexOf('\n', match.index) + 1;
      if (!/^\s*(?:(?:try|await)\s+)*$/.test(safe.slice(lineStart, match.index))) continue;
      let method = verb === 'webSocket' ? 'WS' : verb!.toUpperCase();
      let segs = args!;
      if (verb === 'on') {
        const on = /^\s*\.([A-Z]+)\s*,?(.*)$/s.exec(args!);
        if (!on) continue;
        method = on[1]!;
        segs = on[2]!;
      }
      const line = safe.slice(0, match.index).split('\n').length;
      const routePath = (groupPrefix.get(receiver!) ?? '') + segJoin('', segs) || '/';
      const id = `route:${filePath}:${line}:${method}:${routePath}`;
      nodes.push({
        id, kind: 'route', name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`, filePath, startLine: line, endLine: line,
        startColumn: 0, endColumn: match[0].length, language: 'swift', updatedAt: now,
      });
      // The closure IS the handler: its calls are the route's, as an Express
      // inline handler's are, so Steps draws what `GET hello` does.
      const open = match.index + match[0].length - 1;
      const close = closingBrace(safe, open);
      if (close > open) {
        for (const name of closureCallNames(safe.slice(open + 1, close))) {
          references.push({ fromNodeId: id, referenceName: name, referenceKind: 'calls', line, column: 0, filePath, language: 'swift' });
        }
      }
    }

    return { nodes, references };
  },
};

/** The `}` matching the `{` at `open`; string literals are skipped. -1 when unbalanced. */
function closingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Words Swift writes before a `(` that are not calls. */
const SWIFT_NOT_CALLS = new Set(['if', 'guard', 'switch', 'while', 'for', 'return', 'catch', 'case', 'in', 'try', 'await', 'throw', 'some', 'any']);

/**
 * The calls a route closure's body makes, each once, keeping the receiver
 * (`Todo.query`, `req.auth.require`) so they resolve as calls on it. A member
 * of an expression (`a.b().c(`) names nothing this can follow.
 */
function closureCallNames(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const callRe = /((?:[A-Za-z_]\w*\s*[?!]?\.\s*)*)([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(body)) !== null) {
    const callee = m[2]!;
    const receiver = m[1]!.replace(/[\s?!]/g, '').replace(/\.$/, '');
    if (!receiver && (SWIFT_NOT_CALLS.has(callee) || /[.)\]]\s*$/.test(body.slice(0, m.index)))) continue;
    const name = receiver ? `${receiver}.${callee}` : callee;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Directory patterns
const VIEW_DIRS = ['/Views/', '/View/', '/Screens/', '/Components/', '/UI/'];
const VIEWMODEL_DIRS = ['/ViewModels/', '/ViewModel/', '/Stores/', '/Managers/', '/Services/'];
const MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Domain/'];
const VC_DIRS = ['/ViewControllers/', '/ViewController/', '/Controllers/', '/Screens/'];
const UIVIEW_DIRS = ['/Views/', '/View/', '/UI/', '/Components/'];
const CELL_DIRS = ['/Cells/', '/Cell/', '/Views/', '/TableViewCells/', '/CollectionViewCells/'];
const VAPOR_CONTROLLER_DIRS = ['/Controllers/', '/Controller/', '/Routes/'];
const FLUENT_MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Database/'];
const VAPOR_MIDDLEWARE_DIRS = ['/Middleware/', '/Middlewares/'];

/** A Vapor route's handler ref: `Type@method` (the type may be dotted), or `@method`. */
const VAPOR_HANDLER = /^((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)?@([A-Za-z_]\w*)$/;

/**
 * The handler ref for `use: <expr>`, keeping the type the method is on:
 * `API.PackageController.get` → `API.PackageController@get`; `self.index` and
 * a bare `index` → `@index` (the type the route is written in); `todos.index`
 * → the type `todos` was made from, when the file says.
 */
function vaporHandlerRef(expr: string, receiverTypes: ReadonlyMap<string, string>): string | null {
  const segs = expr.split('.').filter((s) => s.length > 0);
  const method = segs.pop();
  if (!method) return null;
  if (segs[0] === 'self' || segs[0] === 'Self') segs.shift();
  if (segs.length === 0) return `@${method}`;
  if (/^[A-Z]/.test(segs[0]!)) return `${segs.join('.')}@${method}`;
  const type = segs.length === 1 ? receiverTypes.get(segs[0]!) : undefined;
  return type ? `${type}@${method}` : `@${method}`;
}

/**
 * One type's method among `candidates`, or null when they belong to different
 * types. Of a type's overloads, the one declared to take a `Request` — what
 * Vapor calls a handler with — else the earliest.
 */
function oneOwnersMethod(candidates: Node[], ownerOf: (n: Node) => string, context: ResolutionContext): string | null {
  if (candidates.length === 0) return null;
  if (new Set(candidates.map(ownerOf)).size > 1) return null;
  const earliest = (nodes: Node[]) => nodes.reduce((a, b) => (a.startLine <= b.startLine ? a : b)).id;
  if (candidates.length === 1) return candidates[0]!.id;
  const takesRequest = candidates.filter((n) => {
    const lines = context.readFile(n.filePath)?.split(/\r?\n/) ?? [];
    const head = lines.slice(n.startLine - 1, Math.min(n.endLine, n.startLine + 2)).join(' ');
    return /\(\s*(?:\w+\s+)?\w+\s*:\s*Request\b/.test(head);
  });
  return earliest(takesRequest.length > 0 ? takesRequest : candidates);
}

function resolveVaporHandler(typePath: string | null, method: string, ref: UnresolvedRef, context: ResolutionContext): string | null {
  const callables = context
    .getNodesByName(method)
    .filter((n) => (n.kind === 'method' || n.kind === 'function') && n.language === 'swift');
  if (callables.length === 0) return null;
  const ownerOf = (n: Node): string => n.qualifiedName.slice(0, Math.max(0, n.qualifiedName.length - method.length - 2));

  if (typePath === null) {
    // `use: self.index` / `use: index`: the type whose body holds the route —
    // its own method in this file, else one declared in another extension of it.
    const owner = context
      .getNodesInFile(ref.filePath)
      .filter((n) => SWIFT_TYPE_KINDS.has(n.kind) && n.startLine <= ref.line && n.endLine >= ref.line)
      .reduce<Node | null>((inner, n) => (!inner || n.startLine >= inner.startLine ? n : inner), null);
    if (!owner) {
      // A route in a top-level `func routes(_ app:)` names a function in scope.
      const functions = callables.filter((n) => n.kind === 'function');
      const sameFile = functions.filter((n) => n.filePath === ref.filePath);
      if (sameFile.length > 0) return oneOwnersMethod(sameFile, ownerOf, context);
      return functions.length === 1 ? functions[0]!.id : null;
    }
    const own = callables.filter(
      (n) => n.filePath === ref.filePath && n.startLine >= owner.startLine && n.endLine <= owner.endLine
    );
    if (own.length > 0) return oneOwnersMethod(own, ownerOf, context);
    typePath = owner.qualifiedName.replace(/::/g, '.');
  }

  const segs = typePath.split('.');
  const type = segs[segs.length - 1]!;
  const full = segs.join('::');
  const exact = callables.filter((n) => ownerOf(n) === full);
  if (exact.length > 0) return oneOwnersMethod(exact, ownerOf, context);
  const nested = callables.filter((n) => ownerOf(n).endsWith(`::${full}`));
  if (nested.length > 0) return oneOwnersMethod(nested, ownerOf, context);
  if (segs.length > 1) {
    // `extension API.PackageController { static func get }` names its node by
    // the last segment (`PackageController::get`) — the same QN a top-level
    // `PackageController`'s method has, so the extension's own line decides.
    const declared = new RegExp(String.raw`\bextension\s+${segs.join(String.raw`\s*\.\s*`)}\b`);
    const inExtension = callables.filter((n) => {
      if (ownerOf(n) !== type) return false;
      const owner = context
        .getNodesInFile(n.filePath)
        .filter((o) => SWIFT_TYPE_KINDS.has(o.kind) && o.name === type && o.startLine <= n.startLine && o.endLine >= n.endLine)
        .reduce<Node | null>((inner, o) => (!inner || o.startLine >= inner.startLine ? o : inner), null);
      if (!owner) return false;
      // The node starts at its attributes (`@available(…)`), the keyword a line or two on.
      const head = (context.readFile(n.filePath)?.split(/\r?\n/) ?? []).slice(owner.startLine - 1, owner.startLine + 2).join(' ');
      return declared.test(head);
    });
    return oneOwnersMethod(inExtension, ownerOf, context);
  }
  // A type named without the namespace it is nested in — only when one type fits.
  return oneOwnersMethod(callables.filter((n) => ownerOf(n).endsWith(`::${type}`)), ownerOf, context);
}

const SWIFT_TYPE_KINDS = new Set(['class', 'struct', 'enum', 'protocol']);

const VIEW_KINDS = new Set(['struct']);
const CLASS_KINDS = new Set(['class']);
const MODEL_KINDS = new Set(['struct', 'class']);
const PROTOCOL_KINDS = new Set(['protocol']);
const VAPOR_CONTROLLER_KINDS = new Set(['class', 'struct']);

/** A framework name heuristic's pick (see name-heuristic.ts), preferring these folders. */
function resolveByNameAndKind(
  ref: UnresolvedRef,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  return pickByNameAndKind(ref, kinds, (f) => preferredDirPatterns.some((d) => f.includes(d)), context);
}
