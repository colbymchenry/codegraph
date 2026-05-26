/**
 * Flutter Framework Resolver
 *
 * Handles Flutter widgets (StatelessWidget/StatefulWidget + State pairing),
 * navigation (MaterialApp routes + GoRouter), and popular state-management
 * packages (Provider, Riverpod, Bloc/Cubit, GetX).
 *
 * Mirrors the layout of swift.ts: multiple resolvers in one file, each with
 * its own detect() so a project that uses Bloc but not Riverpod only pays for
 * the Bloc patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

// ===========================================================================
// flutterResolver — core widget framework
// ===========================================================================

export const flutterResolver: FrameworkResolver = {
  name: 'flutter',
  languages: ['dart'],

  detect(context: ResolutionContext): boolean {
    // Primary signal: pubspec.yaml with a `flutter:` SDK block under deps.
    const pubspec = context.readFile('pubspec.yaml');
    if (pubspec && /^\s*flutter\s*:\s*\n\s*sdk\s*:\s*flutter\b/m.test(pubspec)) {
      return true;
    }

    // Fallback: any .dart file imports package:flutter/*.
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (!file.endsWith('.dart')) continue;
      const content = context.readFile(file);
      if (content && /import\s+['"]package:flutter\//.test(content)) {
        return true;
      }
    }

    return false;
  },

  claimsReference(name: string): boolean {
    // State<MyWidget> reaches here as the bare name `State` — let it through
    // so we can pair it with its widget via the candidates field.
    return name === 'State';
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: framework-provided imports (package:flutter/*, dart:ui, etc.)
    if (ref.referenceKind === 'imports') {
      if (
        ref.referenceName.startsWith('package:flutter/') ||
        ref.referenceName.startsWith('package:flutter_') ||
        ref.referenceName === 'dart:ui' ||
        ref.referenceName === 'dart:ui_web'
      ) {
        return frameworkSelf(ref, 1.0);
      }
    }

    // Pattern 2: State<X> companion — pair to the widget class named in
    // candidates (extract() seeds the candidates list for this case).
    // Checked BEFORE the built-in short-circuit so a `State` ref with
    // candidates resolves to the widget instead of self-targeting.
    if (ref.referenceName === 'State' && ref.candidates && ref.candidates.length > 0) {
      const widgetName = ref.candidates[0]!;
      const widget = context
        .getNodesByName(widgetName)
        .find((n) => n.kind === 'class' || n.kind === 'component');
      if (widget) {
        return {
          original: ref,
          targetNodeId: widget.id,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: built-in Material/Cupertino/Widgets — short-circuit so the
    // name resolver doesn't waste cycles looking for user-defined nodes.
    if (FLUTTER_BUILTIN_WIDGETS.has(ref.referenceName)) {
      return frameworkSelf(ref, 1.0);
    }

    // Pattern 4: user widget reference — PascalCase, look up as class/component.
    if (isPascalCase(ref.referenceName)) {
      const result = resolveByNameAndKind(
        ref.referenceName,
        WIDGET_CLASS_KINDS,
        [...WIDGET_DIRS, ...SCREEN_DIRS],
        ref.filePath,
        context
      );
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.dart')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'dart');

    // class FooBar extends StatelessWidget | StatefulWidget | ConsumerWidget | HookWidget | ...
    const widgetPattern = /\bclass\s+(\w+)(?:\s*<[^>]+>)?\s+extends\s+((?:Stateless|Stateful|Consumer(?:Stateful)?|Hook(?:Consumer)?|InheritedWidget|StatefulHook)Widget|StatelessWidget|StatefulWidget)\b/g;
    let match: RegExpExecArray | null;
    while ((match = widgetPattern.exec(safe)) !== null) {
      const [, widgetName] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      nodes.push({
        id: `widget:${filePath}:${widgetName}:${line}`,
        kind: 'component',
        name: widgetName!,
        qualifiedName: `${filePath}::${widgetName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'dart',
        updatedAt: now,
      });
    }

    // class _FooBarState extends State<FooBar> { ... } — pair with its widget.
    const statePattern = /\bclass\s+(\w+)(?:\s*<[^>]+>)?\s+extends\s+(?:State|ConsumerState)\s*<\s*(\w+)\s*>/g;
    while ((match = statePattern.exec(safe)) !== null) {
      const [, stateName, widgetName] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const stateNode: Node = {
        id: `state:${filePath}:${stateName}:${line}`,
        kind: 'component',
        name: stateName!,
        qualifiedName: `${filePath}::${stateName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'dart',
        updatedAt: now,
      };
      nodes.push(stateNode);
      // Reference from State class → its widget (the candidate carries the
      // widget name so resolve() can pair them under the `State` short name).
      references.push({
        fromNodeId: stateNode.id,
        referenceName: 'State',
        referenceKind: 'extends',
        line,
        column: 0,
        filePath,
        language: 'dart',
        candidates: [widgetName!],
      });
    }

    // void main() { runApp(MyApp()); } — emit an `app` node for the root widget.
    const runAppPattern = /\brunApp\s*\(\s*(?:const\s+)?(\w+)\s*\(/g;
    while ((match = runAppPattern.exec(safe)) !== null) {
      const [, rootName] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      // Don't double-count: only if not already a Material/Cupertino built-in
      if (!FLUTTER_BUILTIN_WIDGETS.has(rootName!)) {
        nodes.push({
          id: `app:${filePath}:${rootName}:${line}`,
          kind: 'class',
          name: rootName!,
          qualifiedName: `${filePath}::${rootName}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'dart',
          updatedAt: now,
        });
      }
    }

    return { nodes, references };
  },
};

// ===========================================================================
// flutterRouterResolver — Navigator named routes + GoRouter
// ===========================================================================

export const flutterRouterResolver: FrameworkResolver = {
  name: 'flutter-router',
  languages: ['dart'],

  detect(context: ResolutionContext): boolean {
    const pubspec = context.readFile('pubspec.yaml');
    if (pubspec && /\bgo_router\s*:/.test(pubspec)) {
      return true;
    }
    // Also detect inline named-routes maps in MaterialApp.
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (!file.endsWith('.dart')) continue;
      const content = context.readFile(file);
      if (!content) continue;
      if (/MaterialApp\s*\([\s\S]{0,500}\broutes\s*:\s*\{/.test(content)) {
        return true;
      }
      if (/\bGoRoute\s*\(/.test(content)) {
        return true;
      }
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Route→handler refs synthesized in extract() carry a PascalCase widget
    // class name. Resolve them preferring screen/page dirs.
    if (isPascalCase(ref.referenceName) && ref.referenceKind === 'references') {
      const result = resolveByNameAndKind(
        ref.referenceName,
        WIDGET_CLASS_KINDS,
        [...SCREEN_DIRS, ...WIDGET_DIRS],
        ref.filePath,
        context
      );
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.dart')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const safe = stripCommentsForRegex(content, 'dart');

    // MaterialApp(... routes: { '/foo': (ctx) => FooScreen(), '/bar': (ctx) { return BarScreen(); } })
    const materialRoutesBlock = safe.match(/MaterialApp\s*\([\s\S]*?\broutes\s*:\s*\{([\s\S]*?)\n\s*\}/);
    if (materialRoutesBlock && materialRoutesBlock[1]) {
      const body = materialRoutesBlock[1];
      const bodyOffset = materialRoutesBlock.index! + materialRoutesBlock[0].indexOf(body);
      // Accept arrow form `=> Screen(` and block form `{ ... return Screen(`.
      // Allow optional generics on the widget name (`Page<dynamic>(`).
      const entryRegex = /['"]([^'"]+)['"]\s*:\s*\([^)]*\)\s*(?:=>\s*(?:const\s+)?(\w+)(?:\s*<[^>]+>)?\s*\(|\{[\s\S]*?\breturn\s+(?:const\s+)?(\w+)(?:\s*<[^>]+>)?\s*\()/g;
      let em: RegExpExecArray | null;
      while ((em = entryRegex.exec(body)) !== null) {
        const path = em[1]!;
        const handler = em[2] ?? em[3];
        if (!handler) continue;
        const absIdx = bodyOffset + em.index;
        const line = safe.slice(0, absIdx).split('\n').length;
        emitRoute(nodes, references, filePath, path, handler, line, em[0].length);
      }
    }

    // GoRouter / ShellRoute / GoRoute(path: '/x', builder: (c, s) => XScreen())
    // Handles nested routes by tracking parent path prefix via a depth-aware
    // walk of `GoRoute(...)` calls. We don't parse the full Dart AST — we
    // scan for GoRoute openings, capture their `path:` and `builder:` /
    // `pageBuilder:`, and track parent prefix on a stack as we descend into
    // a `routes:` array.
    extractGoRouter(safe, filePath, nodes, references);

    return { nodes, references };
  },
};

function extractGoRouter(
  safe: string,
  filePath: string,
  nodes: Node[],
  references: UnresolvedRef[]
): void {
  // Scan for `GoRoute(` and `ShellRoute(` openings. Use a stack of
  // {parentPrefix, closeAt} entries. closeAt is the matching `)` of the
  // owning route — when we cross it, pop. Within each route, look for
  // `path: '...'`, `builder: (...) => Widget(`, and a `routes: [` opening
  // that pushes a child frame.
  type Frame = { parentPrefix: string; closeAt: number; ownPath: string | null; handlerEmitted: boolean };
  const stack: Frame[] = [];
  let i = 0;
  const n = safe.length;

  const findMatchingParen = (start: number): number => {
    let depth = 0;
    for (let j = start; j < n; j++) {
      const c = safe[j];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  };

  while (i < n) {
    // Pop any frames whose route has closed.
    while (stack.length > 0 && i >= stack[stack.length - 1]!.closeAt) {
      stack.pop();
    }

    const goRoute = safe.indexOf('GoRoute(', i);
    const shellRoute = safe.indexOf('ShellRoute(', i);
    let next = -1;
    let openOffset = 0;
    if (goRoute !== -1 && (shellRoute === -1 || goRoute < shellRoute)) {
      next = goRoute;
      openOffset = 'GoRoute'.length;
    } else if (shellRoute !== -1) {
      next = shellRoute;
      openOffset = 'ShellRoute'.length;
    }
    if (next === -1) break;

    // Pop frames closed before this opening.
    while (stack.length > 0 && next >= stack[stack.length - 1]!.closeAt) {
      stack.pop();
    }

    const openParen = next + openOffset;
    const closeAt = findMatchingParen(openParen);
    if (closeAt === -1) break;

    const parentPrefix = stack.length > 0 ? stack[stack.length - 1]!.parentPrefix : '';
    const fullBody = safe.slice(openParen + 1, closeAt);

    // Limit the search to TOP-LEVEL params of this route — everything before
    // the `routes: [` array opening. Otherwise `path:` / `pageBuilder:` regex
    // matches against a descendant GoRoute's values and produces phantom
    // route nodes attributed to the wrong path (or wrapper widget).
    const childrenIdx = fullBody.search(/\broutes\s*:\s*\[/);
    const body = childrenIdx >= 0 ? fullBody.slice(0, childrenIdx) : fullBody;

    // path: '...' OR path: SomeConst.member  (real-world Flutter apps
    // commonly centralize route paths in a `class Routes { static const … }`
    // file and reference them as `Routes.login`. Without this, only routes
    // whose path is an inline string literal get picked up.)
    let ownPath: string | null = null;
    const pathMatch = body.match(/\bpath\s*:\s*(?:['"]([^'"]*)['"]|([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*))/);
    if (pathMatch) {
      ownPath = pathMatch[1] ?? pathMatch[2] ?? '';
    }

    // builder or pageBuilder accepts both expression form (=> Widget(…)) and
    // block form ({ … return Widget(…); }). Real-world GoRouter code uses the
    // block form for any non-trivial route (auth gating, page-transition
    // wrappers), so missing it leaves most routes unparsed.
    // Allow generic-typed widget names (`FadeTransitionPage<dynamic>(`) — without
    // this, the regex stops at the bare name and the trailing `<` makes the
    // pattern fail, so backtracking falls through to a DEEPER `return Widget(`
    // (e.g. the nested `Builder(builder: …) { return BookList(...)`), capturing
    // the wrong handler.
    let handler: string | null = null;
    const arrowMatch = body.match(/\b(?:builder|pageBuilder)\s*:\s*\([^)]*\)\s*=>\s*(?:const\s+)?(\w+)(?:\s*<[^>]+>)?\s*\(/);
    if (arrowMatch) {
      handler = arrowMatch[1] ?? null;
    } else {
      const blockMatch = body.match(/\b(?:builder|pageBuilder)\s*:\s*\([^)]*\)\s*\{[\s\S]*?\breturn\s+(?:const\s+)?(\w+)(?:\s*<[^>]+>)?\s*\(/);
      if (blockMatch) handler = blockMatch[1] ?? null;
    }

    const fullPath = joinGoRoutePath(parentPrefix, ownPath);

    if (ownPath !== null && handler) {
      const absIdx = next;
      const line = safe.slice(0, absIdx).split('\n').length;
      emitRoute(nodes, references, filePath, fullPath, handler, line, openOffset);
    }

    // Push frame so any nested `routes:` will inherit fullPath.
    stack.push({ parentPrefix: fullPath, closeAt, ownPath, handlerEmitted: !!handler });

    // Skip past the route's `routes: [...]` so we don't re-scan its inside as
    // a sibling. Walking is handled by stack pop above; just advance past the
    // GoRoute(/ShellRoute( opening so we don't infinite-loop on this match.
    i = openParen + 1;
  }
}

function joinGoRoutePath(parent: string, own: string | null): string {
  if (!own) return parent || '/';
  if (own.startsWith('/')) return own;                  // absolute child
  if (!parent || parent === '/') return '/' + own.replace(/^\/+/, '');
  return parent.replace(/\/+$/, '') + '/' + own.replace(/^\/+/, '');
}

function emitRoute(
  nodes: Node[],
  references: UnresolvedRef[],
  filePath: string,
  path: string,
  handler: string,
  line: number,
  endColumn: number
): void {
  const normalized = path.startsWith('/') ? path : '/' + path;
  const routeNode: Node = {
    id: `route:${filePath}:${line}:${normalized}`,
    kind: 'route',
    name: normalized,
    qualifiedName: `${filePath}::route:${normalized}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn,
    language: 'dart',
    updatedAt: Date.now(),
  };
  nodes.push(routeNode);
  references.push({
    fromNodeId: routeNode.id,
    referenceName: handler,
    referenceKind: 'references',
    line,
    column: 0,
    filePath,
    language: 'dart',
  });
}

// ===========================================================================
// flutterStateResolver — Provider / Riverpod / Bloc / GetX
// ===========================================================================

export const flutterStateResolver: FrameworkResolver = {
  name: 'flutter-state',
  languages: ['dart'],

  detect(context: ResolutionContext): boolean {
    const flags = readStateMgmtFlags(context);
    return flags.provider || flags.riverpod || flags.bloc || flags.getx;
  },

  claimsReference(name: string): boolean {
    // Dispatch shapes the dart extractor surfaces as `obj.method` — these are
    // framework dispatches with no user-declared symbol of that name.
    return STATE_DISPATCH_NAMES.has(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const flags = readStateMgmtFlags(context);

    // Pattern 1: framework dispatch shapes → self-target (1.0). Short-circuits
    // so fuzzy name matching doesn't link these calls to unrelated symbols.
    if (STATE_DISPATCH_NAMES.has(ref.referenceName)) {
      if (
        (flags.provider && PROVIDER_DISPATCH.has(ref.referenceName)) ||
        (flags.riverpod && RIVERPOD_DISPATCH.has(ref.referenceName)) ||
        (flags.bloc && BLOC_DISPATCH.has(ref.referenceName)) ||
        (flags.getx && GETX_DISPATCH.has(ref.referenceName))
      ) {
        return frameworkSelf(ref, 1.0);
      }
    }

    // Pattern 2: Riverpod *Provider symbols (provider variables/functions
    // declared at top level) — prefer provider/state dirs.
    if (flags.riverpod && /Provider$/.test(ref.referenceName) && isPascalishVariable(ref.referenceName)) {
      const result = resolveByNameAndKind(
        ref.referenceName,
        PROVIDER_KINDS,
        PROVIDER_DIRS,
        ref.filePath,
        context
      );
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
      }
    }

    // Pattern 3: Bloc/Cubit classes — prefer bloc/cubit dirs.
    if (flags.bloc && (/Bloc$/.test(ref.referenceName) || /Cubit$/.test(ref.referenceName))) {
      const result = resolveByNameAndKind(
        ref.referenceName,
        WIDGET_CLASS_KINDS,
        BLOC_DIRS,
        ref.filePath,
        context
      );
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
      }
    }

    // Pattern 4: GetX *Controller classes — prefer controller dirs.
    if (flags.getx && /Controller$/.test(ref.referenceName) && isPascalCase(ref.referenceName)) {
      const result = resolveByNameAndKind(
        ref.referenceName,
        WIDGET_CLASS_KINDS,
        GETX_DIRS,
        ref.filePath,
        context
      );
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
      }
    }

    return null;
  },
};

function readStateMgmtFlags(context: ResolutionContext): {
  provider: boolean;
  riverpod: boolean;
  bloc: boolean;
  getx: boolean;
} {
  const pubspec = context.readFile('pubspec.yaml') ?? '';
  return {
    provider: /^\s*provider\s*:/m.test(pubspec),
    riverpod: /^\s*(?:flutter_)?riverpod\s*:/m.test(pubspec) || /^\s*hooks_riverpod\s*:/m.test(pubspec),
    bloc: /^\s*(?:flutter_)?bloc\s*:/m.test(pubspec),
    // `get:` matches the GetX package; pubspec keys are unique so no collision.
    getx: /^\s*get\s*:/m.test(pubspec) || /^\s*get_it\s*:/m.test(pubspec),
  };
}

// ===========================================================================
// Shared helpers
// ===========================================================================

function frameworkSelf(ref: UnresolvedRef, confidence: number): ResolvedRef {
  return {
    original: ref,
    targetNodeId: ref.fromNodeId,
    confidence,
    resolvedBy: 'framework',
  };
}

function isPascalCase(s: string): boolean {
  return /^[A-Z][a-zA-Z0-9_]*$/.test(s);
}

// Riverpod providers are camelCase variables (e.g. `userProvider`), not
// PascalCase classes — accept either so we cover both `final userProvider =
// Provider(...)` and a hypothetical `UserProvider` class.
function isPascalishVariable(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  fromFilePath: string,
  context: ResolutionContext
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;
  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer same-file
  const sameFile = kindFiltered.filter((n) => n.filePath === fromFilePath);
  if (sameFile.length > 0) return sameFile[0]!.id;

  // Prefer same-directory
  const fromDir = fromFilePath.substring(0, fromFilePath.lastIndexOf('/'));
  if (fromDir) {
    const sameDir = kindFiltered.filter((n) => n.filePath.startsWith(fromDir + '/'));
    if (sameDir.length > 0) return sameDir[0]!.id;
  }

  // Prefer framework-conventional directories
  if (preferredDirPatterns.length > 0) {
    const preferred = kindFiltered.filter((n) =>
      preferredDirPatterns.some((d) => n.filePath.includes(d))
    );
    if (preferred.length > 0) return preferred[0]!.id;
  }

  return kindFiltered[0]!.id;
}

// ===========================================================================
// Constants
// ===========================================================================

const WIDGET_DIRS = ['/lib/widgets/', '/lib/components/', '/lib/ui/'];
const SCREEN_DIRS = ['/lib/screens/', '/lib/pages/', '/lib/views/', '/lib/routes/'];
const PROVIDER_DIRS = ['/lib/providers/', '/lib/state/', '/lib/notifiers/'];
const BLOC_DIRS = ['/lib/bloc/', '/lib/blocs/', '/lib/cubit/', '/lib/cubits/'];
const GETX_DIRS = ['/lib/controllers/', '/lib/getx/'];

const WIDGET_CLASS_KINDS = new Set(['class', 'component']);
const PROVIDER_KINDS = new Set(['variable', 'constant', 'function', 'class']);

const PROVIDER_DISPATCH = new Set([
  'Provider.of',
  'context.read',
  'context.watch',
  'context.select',
  'Consumer',
  'Consumer2',
  'Consumer3',
  'MultiProvider',
  'ChangeNotifierProvider',
  'FutureProvider',
  'StreamProvider',
  'ListenableProvider',
  'ValueListenableProvider',
  'ProxyProvider',
]);

const RIVERPOD_DISPATCH = new Set([
  'ref.read',
  'ref.watch',
  'ref.listen',
  'ref.refresh',
  'ref.invalidate',
  'ProviderScope',
  'Consumer',
  'ConsumerWidget',
  'ConsumerStatefulWidget',
  'HookConsumerWidget',
  'useProvider',
]);

const BLOC_DISPATCH = new Set([
  'BlocProvider',
  'BlocProvider.of',
  'BlocBuilder',
  'BlocListener',
  'BlocConsumer',
  'BlocSelector',
  'MultiBlocProvider',
  'MultiBlocListener',
  'RepositoryProvider',
  'MultiRepositoryProvider',
  'context.read',
  'context.watch',
]);

const GETX_DISPATCH = new Set([
  'Get.find',
  'Get.put',
  'Get.lazyPut',
  'Get.create',
  'Get.delete',
  'Get.to',
  'Get.toNamed',
  'Get.back',
  'Get.off',
  'Get.offAll',
  'GetBuilder',
  'GetX',
  'Obx',
  'GetMaterialApp',
]);

const STATE_DISPATCH_NAMES = new Set<string>([
  ...PROVIDER_DISPATCH,
  ...RIVERPOD_DISPATCH,
  ...BLOC_DISPATCH,
  ...GETX_DISPATCH,
]);

/**
 * Common Material/Cupertino/Widgets-library widget names. Not exhaustive — the
 * goal is to short-circuit name resolution for the widgets a Flutter app
 * touches on nearly every screen, so the name resolver doesn't waste cycles
 * looking for user-defined symbols. Add more as benchmarks reveal misses.
 */
const FLUTTER_BUILTIN_WIDGETS = new Set([
  // App / scaffolding
  'MaterialApp', 'CupertinoApp', 'WidgetsApp', 'Scaffold', 'CupertinoPageScaffold',
  'AppBar', 'CupertinoNavigationBar', 'SliverAppBar', 'BottomNavigationBar',
  'CupertinoTabBar', 'CupertinoTabScaffold', 'Drawer', 'EndDrawer', 'NavigationBar',
  'NavigationRail', 'TabBar', 'TabBarView', 'TabController', 'DefaultTabController',
  // Layout
  'Container', 'Row', 'Column', 'Stack', 'IndexedStack', 'Wrap', 'Flow', 'Table',
  'Padding', 'Center', 'Align', 'Positioned', 'Expanded', 'Flexible', 'Spacer',
  'SizedBox', 'ConstrainedBox', 'FractionallySizedBox', 'AspectRatio', 'FittedBox',
  'IntrinsicWidth', 'IntrinsicHeight', 'Baseline', 'LimitedBox', 'OverflowBox',
  'SafeArea', 'Material', 'DecoratedBox', 'Card', 'Chip', 'Dialog', 'AlertDialog',
  'SimpleDialog', 'CupertinoAlertDialog', 'BottomSheet', 'PopupMenuButton', 'Banner',
  // Scrolling
  'ListView', 'GridView', 'SingleChildScrollView', 'CustomScrollView', 'NestedScrollView',
  'PageView', 'Scrollbar', 'ReorderableListView', 'RefreshIndicator',
  // Display
  'Text', 'RichText', 'SelectableText', 'Icon', 'ImageIcon', 'Image', 'FadeInImage',
  'CircleAvatar', 'Divider', 'VerticalDivider', 'Placeholder', 'Tooltip', 'Badge',
  'Hero', 'Visibility', 'Offstage', 'Opacity', 'CircularProgressIndicator',
  'LinearProgressIndicator', 'CupertinoActivityIndicator',
  // Input
  'TextField', 'TextFormField', 'Form', 'FormField', 'CupertinoTextField',
  'ElevatedButton', 'TextButton', 'OutlinedButton', 'IconButton', 'FloatingActionButton',
  'CupertinoButton', 'BackButton', 'CloseButton', 'Checkbox', 'CheckboxListTile',
  'Radio', 'RadioListTile', 'Switch', 'SwitchListTile', 'CupertinoSwitch', 'Slider',
  'CupertinoSlider', 'RangeSlider', 'DropdownButton', 'DropdownButtonFormField',
  'PopupMenuItem', 'MenuItemButton', 'MenuBar', 'SubmenuButton',
  // List items
  'ListTile', 'ExpansionTile', 'CheckboxListTile', 'RadioListTile', 'SwitchListTile',
  // Gesture / interaction
  'GestureDetector', 'InkWell', 'InkResponse', 'Dismissible', 'Draggable', 'DragTarget',
  'AbsorbPointer', 'IgnorePointer', 'Listener', 'MouseRegion',
  // Builders
  'Builder', 'LayoutBuilder', 'StatefulBuilder', 'OrientationBuilder', 'FutureBuilder',
  'StreamBuilder', 'ValueListenableBuilder', 'AnimatedBuilder', 'NotificationListener',
  // Animation
  'AnimatedContainer', 'AnimatedOpacity', 'AnimatedPadding', 'AnimatedPositioned',
  'AnimatedAlign', 'AnimatedDefaultTextStyle', 'AnimatedSwitcher', 'AnimatedCrossFade',
  'FadeTransition', 'ScaleTransition', 'RotationTransition', 'SlideTransition',
  'PositionedTransition', 'SizeTransition', 'TweenAnimationBuilder', 'Hero',
  // Theme / inherited
  'Theme', 'CupertinoTheme', 'DefaultTextStyle', 'IconTheme', 'MediaQuery',
  'Directionality', 'Localizations', 'InheritedWidget', 'InheritedModel',
  // Transforms / clipping
  'Transform', 'RotatedBox', 'ClipRRect', 'ClipRect', 'ClipOval', 'ClipPath',
  'CustomPaint', 'CustomMultiChildLayout', 'CustomSingleChildLayout',
  // Navigation
  'Navigator', 'NavigatorState', 'Route', 'MaterialPageRoute', 'CupertinoPageRoute',
  'PageRouteBuilder', 'ModalRoute', 'WillPopScope', 'PopScope',
  // Base classes (the framework provides these — user code extends them)
  'StatelessWidget', 'StatefulWidget', 'State', 'Widget', 'BuildContext',
  'PreferredSizeWidget', 'RenderObjectWidget', 'ProxyWidget',
]);
