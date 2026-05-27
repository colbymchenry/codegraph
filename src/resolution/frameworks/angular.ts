/**
 * Angular Framework Resolver
 *
 * Handles Angular's decorator-based component / module / DI system across the
 * pieces that are invisible to a pure tree-sitter pass:
 *
 *   - @Component({ selector, templateUrl, template, standalone, imports, ... })
 *   - @NgModule({ declarations, imports, providers, exports, bootstrap })
 *   - @Injectable({ providedIn })
 *   - @Directive({ selector })
 *   - @Pipe({ name })
 *   - Router config: const routes: Routes = [...] + RouterModule.forRoot/forChild
 *
 * Like the other framework extractors this is regex-over-source (comment-
 * stripped), not AST traversal — same approach as nestjsResolver. The bulk of
 * Angular's "static" structure lives in decorator argument literals, which
 * tree-sitter sees only as nested call/object/array expressions.
 *
 * Architecture — three layers, all using the same scanning primitives:
 *   1. `extract()` — per-file: emits route nodes (RouterModule.forRoot, etc.)
 *      and unresolved references from those nodes to component handlers.
 *      Module/component edges are NOT emitted here because their source node
 *      is the TS-extracted class, which `extract()` doesn't have access to.
 *   2. `angularMetadataEdges()` synthesizer — cross-file: emits class→class
 *      edges for @NgModule({declarations,imports,providers,exports,bootstrap})
 *      and standalone @Component({imports}). Runs after the TS extractor so
 *      it can look up class nodes by name.
 *   3. `buildAngularSelectorIndex()` / `buildAngularTemplateOwnerIndex()` —
 *      consumed by the template + selector synthesizers (phases 2 & 3).
 */

import { Edge, Node } from '../../types';
import {
  FrameworkResolver,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';

type JsLang = 'typescript' | 'javascript';

/**
 * NgModule metadata fields whose value is an array of identifiers that all
 * resolve to other module / component / service classes. Each becomes an edge.
 */
const NG_MODULE_ARRAY_FIELDS = [
  'declarations',
  'imports',
  'providers',
  'exports',
  'bootstrap',
] as const;

/**
 * Filename suffixes that strongly hint a file is Angular. Used by detect()
 * for the no-package.json fallback (monorepo subprojects without their own
 * package.json).
 */
const ANGULAR_FILE_HINTS = [
  '.component.ts',
  '.module.ts',
  '.service.ts',
  '.directive.ts',
  '.pipe.ts',
  '.guard.ts',
  '.resolver.ts',
];

/**
 * Kinds eligible to be the TARGET of an Angular metadata edge. Modules,
 * components, services, directives, and pipes are all `class` in tree-sitter
 * output; `function` is the legacy InjectionToken / factory shape.
 */
const TARGET_KINDS = new Set(['class', 'component', 'function']);

export const angularResolver: FrameworkResolver = {
  name: 'angular',
  languages: ['typescript', 'javascript'],

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (Object.keys(deps).some((k) => k.startsWith('@angular/'))) {
          return true;
        }
      } catch {
        // Invalid JSON — fall through.
      }
    }

    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (!ANGULAR_FILE_HINTS.some((suffix) => file.endsWith(suffix))) continue;
      const content = context.readFile(file);
      if (
        content &&
        (content.includes('@angular/') ||
          content.includes('@Component(') ||
          content.includes('@NgModule(') ||
          content.includes('@Directive(') ||
          content.includes('@Injectable('))
      ) {
        return true;
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Convention-based fallback: FooComponent → foo.component.ts, FooService →
    // foo.service.ts, etc. Mirrors nestjsResolver's PROVIDER_CONVENTIONS pattern.
    for (const [suffix, convention] of PROVIDER_CONVENTIONS) {
      if (!suffix.test(ref.referenceName)) continue;
      const candidates = context
        .getNodesByName(ref.referenceName)
        .filter((n) => n.kind === 'class');
      if (candidates.length === 0) return null;
      const preferred = candidates.find((n) => n.filePath.includes(convention));
      const target = preferred ?? candidates[0]!;
      return {
        original: ref,
        targetNodeId: target.id,
        confidence: preferred ? 0.85 : 0.7,
        resolvedBy: 'framework',
      };
    }
    return null;
  },

  extract(filePath, content) {
    if (!/\.(m?js|tsx?|cjs)$/.test(filePath)) return { nodes: [], references: [] };
    // Cheap gate before the comment-stripped scan: the file must look like a
    // routing config (Routes type alias, RouterModule.for*, or provideRouter).
    if (
      !content.includes(': Routes') &&
      !content.includes(': Route[]') &&
      !content.includes('RouterModule.') &&
      !content.includes('provideRouter')
    ) {
      return { nodes: [], references: [] };
    }
    return extractAngularRoutes(filePath, content);
  },
};

// ---------------------------------------------------------------------------
// Convention-based resolution (consumed by resolver.resolve)
// ---------------------------------------------------------------------------

const PROVIDER_CONVENTIONS: Array<[RegExp, string]> = [
  [/Component$/, '.component.'],
  [/Module$/, '.module.'],
  [/Service$/, '.service.'],
  [/Directive$/, '.directive.'],
  [/Pipe$/, '.pipe.'],
  [/Guard$/, '.guard.'],
  [/Resolver$/, '.resolver.'],
  [/Interceptor$/, '.interceptor.'],
];

// ---------------------------------------------------------------------------
// Synthesizer-callable: NgModule + standalone Component metadata edges
// ---------------------------------------------------------------------------

/**
 * Emit class→class edges for Angular module / component metadata. Every
 * identifier appearing in @NgModule({declarations|imports|providers|exports|
 * bootstrap}: [...]) and standalone @Component({imports: [...]}) becomes a
 * `calls` edge tagged with `synthesizedBy:'angular-<field>'`.
 *
 * We deliberately reuse `kind: 'calls'` (not `references`) because trace /
 * explore / impact walk `calls` edges to follow flows — emitting on the
 * Vue/React-style channel means Angular module structure surfaces in the
 * same agent queries without any tool-side wiring.
 *
 * Resolution rule for each identifier `Name`:
 *   1. Prefer a class node literally named `Name` whose file path matches
 *      the convention (`*Component` → `*.component.ts`, …).
 *   2. Fall back to any class node named `Name`.
 *   3. Drop unresolved identifiers (spread elements, dynamic imports, …)
 *      silently — half-bridged edges are worse than none (CLAUDE.md).
 */
export function angularMetadataEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    const content = ctx.readFile(file);
    if (!content) continue;
    // Cheap gate before the more expensive comment-stripped scan.
    if (!content.includes('@NgModule(') && !content.includes('@Component(')) continue;

    const safe = stripCommentsForRegex(content, 'typescript');
    const fileNodes = ctx.getNodesInFile(file);

    for (const hit of findClassDecorators(safe, ['NgModule', 'Component'])) {
      const cls = classAfterDecorator(safe, hit.end);
      if (!cls) continue;
      const owner = fileNodes.find(
        (n) => n.name === cls.className && TARGET_KINDS.has(n.kind)
      );
      if (!owner) continue;

      const fields =
        hit.name === 'NgModule'
          ? NG_MODULE_ARRAY_FIELDS
          : isStandaloneComponent(hit.args)
            ? (['imports'] as const)
            : ([] as const);

      for (const field of fields) {
        const identifiers = extractFieldArrayIdentifiers(hit.args, field);
        for (const name of identifiers) {
          const target = resolveTargetByName(name, file, ctx);
          if (!target || target.id === owner.id) continue;
          const key = `${owner.id}>${target.id}>angular-${field}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: owner.id,
            target: target.id,
            kind: 'calls',
            line: cls.classLine,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: `angular-${field}`,
              via: name,
              registeredAt: `${file}:${cls.classLine}`,
            },
          });
        }
      }
    }
  }

  return edges;
}

/**
 * Pick the best `Name` resolution among same-named class nodes. Prefers a
 * class whose file path matches the Angular naming convention
 * (`FooComponent` → `*.component.ts`), then falls back to first match.
 * Returns `null` when nothing exists — half-bridged edges are worse than none.
 */
function resolveTargetByName(
  name: string,
  fromFile: string,
  ctx: ResolutionContext
): Node | null {
  const candidates = ctx.getNodesByName(name).filter((n) => TARGET_KINDS.has(n.kind));
  if (candidates.length === 0) return null;

  // Same-file wins outright (avoids cross-file mis-match in monorepos).
  const sameFile = candidates.find((n) => n.filePath === fromFile);
  if (sameFile) return sameFile;

  // Convention match: FooComponent in *.component.ts.
  for (const [suffix, convention] of PROVIDER_CONVENTIONS) {
    if (!suffix.test(name)) continue;
    const conventionMatch = candidates.find((n) => n.filePath.includes(convention));
    if (conventionMatch) return conventionMatch;
  }

  return candidates[0]!;
}

// ---------------------------------------------------------------------------
// Phase 2 synthesizer: <app-foo> / [appFoo] → component class edges
// ---------------------------------------------------------------------------

const NG_OPEN_TAG_RE = /<([a-z][a-z0-9-]*)([^>]*)>/gi;
const NG_TEMPLATE_ATTR_RE = /(?:^|\s)(?:\[\(?([a-zA-Z_][\w-]*)\)?\]|([a-zA-Z_][\w-]*))(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s>]+))?/g;
const NG_CLASS_RE = /\S+/g;

/**
 * Per-template emission cap. Defensive against god-templates whose tag fan-out
 * would otherwise dominate the synthesized-edge budget. Same shape as Vue's
 * MAX_JSX_CHILDREN.
 */
const MAX_ANGULAR_TEMPLATE_EDGES = 60;

/**
 * Emit `owner-component → child-component` / `owner → directive-class` edges
 * for every selector match in every component's template. Source point is
 * the owner @Component class node (so `trace`/`callees`/`impact` find the
 * relationship from the parent class).
 *
 * Gate: a tag/attribute must appear in the selector index built from
 * `@Component({ selector })` / `@Directive({ selector })` metadata. Generic
 * HTML tags (`<div>`, `<button>`) and unrelated bracket bindings (`[disabled]`)
 * miss the gate and drop silently.
 */
export function angularSelectorEdges(
  ctx: ResolutionContext,
  selectorIndex?: Map<string, AngularSelector>
): Edge[] {
  const index = selectorIndex ?? buildAngularSelectorIndex(ctx);
  if (index.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const templates = collectComponentTemplates(ctx);

  for (const { owner, template, templateSource } of templates) {
    let added = 0;
    const addEdge = (entry: AngularSelector, via: string) => {
      if (added >= MAX_ANGULAR_TEMPLATE_EDGES) return;
      if (entry.owner.id === owner.id) return; // self-render is meaningless
      const key = `${owner.id}>${entry.owner.id}>angular-selector`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({
        source: owner.id,
        target: entry.owner.id,
        kind: 'calls',
        line: owner.startLine,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'angular-selector',
          via,
          registeredAt: `${templateSource}:${owner.startLine}`,
        },
      });
      added++;
    };

    NG_OPEN_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NG_OPEN_TAG_RE.exec(template)) !== null) {
      const tag = m[1]!.toLowerCase();
      const attrText = m[2] ?? '';

      const tagEntry = index.get(`tag:${tag}`);
      if (tagEntry) addEdge(tagEntry, tag);

      const { attrs, classes } = parseTemplateTagAttributes(attrText);
      for (const attr of attrs) {
        const attrEntry = index.get(`attr:${attr}`);
        if (attrEntry) addEdge(attrEntry, `[${attr}]`);
        const tagAttrEntry = index.get(`tagattr:${tag}[${attr}]`);
        if (tagAttrEntry) addEdge(tagAttrEntry, `${tag}[${attr}]`);
      }
      for (const className of classes) {
        const tagClassEntry = index.get(`tagclass:${tag}.${className}`);
        if (tagClassEntry) addEdge(tagClassEntry, `${tag}.${className}`);
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Phase 3 synthesizer: template bindings → owner class methods/properties
// ---------------------------------------------------------------------------

/**
 * Event binding: `(click)="onSubmit()"`, `(my-event)="handler($event)"`.
 * The value capture is permissive (anything but `"`) — we extract identifiers
 * from it during resolution, not at scan time.
 */
const NG_EVENT_RE = /\(([a-zA-Z][\w-]*)\)\s*=\s*"([^"]*)"/g;

/**
 * Property binding: `[disabled]="isDisabled"`, `[class.x]="cond"`. Same regex
 * shape as NG_ATTR_RE but captures the value too. Two-way `[(banana)]="x"`
 * doesn't match (the inner `(` excludes it) — handled by NG_TWO_WAY_RE.
 */
const NG_PROP_RE = /\[([a-zA-Z][\w.-]*)\]\s*=\s*"([^"]*)"/g;

/**
 * Two-way / banana-in-a-box: `[(ngModel)]="formValue"`.
 */
const NG_TWO_WAY_RE = /\[\(([a-zA-Z][\w-]*)\)\]\s*=\s*"([^"]*)"/g;

/**
 * Structural-directive shorthand: `*ngIf="cond"`, `*ngFor="let x of items"`.
 * The value's microsyntax is parsed loosely — we just extract identifiers
 * and let the resolution gate drop the ones (`let`, `x`, `of`, ...) that
 * aren't class members.
 */
const NG_STRUCT_RE = /\*([a-zA-Z][\w]*)\s*=\s*"([^"]*)"/g;

/**
 * Interpolation: `{{ user.name }}`, `{{ getStatus(x) }}`. Multi-line
 * interpolations work too — `[^}]+?` is non-greedy.
 */
const NG_INTERPOLATION_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Identifiers in a binding expression. Used after the regexes above capture
 * a value-string; we walk it and try each identifier against the owner's
 * class members.
 */
const NG_IDENT_RE = /[a-zA-Z_$][\w$]*/g;

/**
 * Angular 17+ control-flow blocks with an expression: `@if (...)`,
 * `@else if (...)`, `@for (...)`, `@switch (...)`, `@case (...)`, `@defer
 * (...)`. The opening `(` is included so the caller hands the balanced
 * reader the right position. Forms without expressions (`@else`, `@empty`,
 * `@default`, `@placeholder`, `@loading`, `@error`) are intentionally not
 * captured — they carry no identifier to resolve.
 */
const NG_BLOCK_KEYWORD_RE = /@(if|else\s+if|for|switch|case|defer)\s*\(/g;

/**
 * Angular v18+ `@let name = expr;` template variables. The expression runs
 * from `=` to the first top-level `;`. We extract identifiers from the
 * expression — the local name (`name`) itself is a template-local and won't
 * resolve to a class member, so we deliberately don't index it.
 */
const NG_LET_RE = /@let\s+\w+\s*=([^;]+);/g;

/**
 * Template / microsyntax / JS-global names that are NEVER component members.
 * The resolution gate would drop them anyway (no node would match), but
 * pre-filtering keeps the candidate count proportional to real members.
 */
const NG_TEMPLATE_STOP_WORDS = new Set([
  // Angular template variables
  '$event', '$any', '$index', '$count', '$first', '$last', '$even', '$odd', '$implicit',
  // ngFor microsyntax
  'let', 'of', 'as', 'trackBy',
  // JS literals
  'null', 'undefined', 'true', 'false',
  // JS keywords that can appear in expressions
  'new', 'typeof', 'instanceof', 'in', 'void', 'delete',
  // Common JS globals
  'Math', 'Array', 'Object', 'Date', 'JSON', 'console', 'window', 'document',
  'Number', 'String', 'Boolean', 'Promise', 'Symbol', 'RegExp',
]);

/**
 * Class-member kinds we'll resolve template identifiers against. Tree-sitter-
 * typescript emits class fields and methods as `method` (the extractor maps
 * both `method_definition` and `public_field_definition` to that kind); we
 * also accept `property`, `field`, `variable`, `constant`, `function` to be
 * inclusive across the different shapes Angular code takes (e.g. arrow
 * methods declared as fields, signal-style properties).
 */
const NG_MEMBER_KINDS = new Set(['method', 'property', 'field', 'variable', 'constant', 'function']);

/**
 * Emit `owner-component → owner-class-member` edges for each binding in the
 * component's template. Closes the click → handler / interpolation → getter
 * loop that tree-sitter can't see (template lives in a string literal or a
 * separate .html file).
 *
 * Resolution rule:
 *   - identifier MUST resolve to a node in the owner's same file
 *   - identifier's node MUST be inside the owner-class line range (so we
 *     don't catch unrelated functions or other classes in the same file)
 *   - kind ∈ NG_MEMBER_KINDS
 *
 * Two-way bindings emit one edge (the target is the owner field — Angular's
 * banana box desugars to `(modelChange)="x = $event" [model]="x"`, but for
 * trace purposes the field itself is enough).
 */
export function angularTemplateEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const templates = collectComponentTemplates(ctx);

  for (const { owner, template, templateSource } of templates) {
    // Pre-compute candidate class members in the owner file, filtered to
    // those that fall within the owner's line range. This is the per-owner
    // lookup table — name → first matching member node.
    const memberByName = buildOwnerMemberIndex(owner, ctx);
    if (memberByName.size === 0) continue;

    let added = 0;
    const addEdge = (target: Node, via: string, kindTag: string) => {
      if (added >= MAX_ANGULAR_TEMPLATE_EDGES) return;
      if (target.id === owner.id) return;
      const key = `${owner.id}>${target.id}>angular-template:${kindTag}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({
        source: owner.id,
        target: target.id,
        kind: 'calls',
        line: owner.startLine,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'angular-template',
          via,
          kind: kindTag,
          registeredAt: `${templateSource}:${owner.startLine}`,
        },
      });
      added++;
    };

    // Each capture kind contributes (event-name|prop-name, value-expr).
    // We re-use the same identifier-resolution path for all of them.
    const captures: Array<{ re: RegExp; tag: string; preserveAttrInVia?: boolean }> = [
      { re: NG_EVENT_RE, tag: 'event', preserveAttrInVia: true },
      { re: NG_PROP_RE, tag: 'property', preserveAttrInVia: true },
      { re: NG_TWO_WAY_RE, tag: 'two-way', preserveAttrInVia: true },
      { re: NG_STRUCT_RE, tag: 'structural', preserveAttrInVia: true },
    ];
    for (const { re, tag, preserveAttrInVia } of captures) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(template)) !== null) {
        const attr = m[1]!;
        const expr = m[2]!;
        for (const ident of identifiersInExpression(expr)) {
          const target = memberByName.get(ident);
          if (!target) continue;
          const via = preserveAttrInVia ? `${attr}=${ident}` : ident;
          addEdge(target, via, tag);
        }
      }
    }

    // Interpolation captures: `{{ expr }}`.
    NG_INTERPOLATION_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = NG_INTERPOLATION_RE.exec(template)) !== null) {
      const expr = im[1]!;
      for (const ident of identifiersInExpression(expr)) {
        const target = memberByName.get(ident);
        if (!target) continue;
        addEdge(target, ident, 'interpolation');
      }
    }

    // Angular 17+ control-flow blocks: `@if (...)`, `@for (... of expr; ...)`,
    // `@switch (expr)`, `@case (v)`, `@defer (...)`, `@else if (...)`. Same
    // resolution as structural directives — the inside-parens expression is
    // walked for identifiers, each tried against the owner class.
    NG_BLOCK_KEYWORD_RE.lastIndex = 0;
    let bm: RegExpExecArray | null;
    while ((bm = NG_BLOCK_KEYWORD_RE.exec(template)) !== null) {
      const keyword = bm[1]!.replace(/\s+/g, ' '); // normalize "else  if" → "else if"
      const openIdx = bm.index + bm[0].length - 1; // position of '('
      const args = readBalanced(template, openIdx, '(', ')');
      if (!args) continue;
      // Resume past the closing `)` so a nested `@for` inside `@if` isn't missed
      // and so the balanced args we just consumed don't get re-scanned.
      NG_BLOCK_KEYWORD_RE.lastIndex = args.end;
      for (const ident of identifiersInExpression(args.inner)) {
        const target = memberByName.get(ident);
        if (!target) continue;
        addEdge(target, `@${keyword}=${ident}`, `block-${keyword.split(' ')[0]}`);
      }
    }

    // Angular v18+ `@let name = expr;`.
    NG_LET_RE.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = NG_LET_RE.exec(template)) !== null) {
      for (const ident of identifiersInExpression(lm[1]!)) {
        const target = memberByName.get(ident);
        if (!target) continue;
        addEdge(target, ident, 'let');
      }
    }
  }

  return edges;
}

/**
 * Build a `name → member node` lookup for one component class. Members are
 * filtered by:
 *   - owner file (no cross-file false matches in a monorepo)
 *   - line range within `[owner.startLine, owner.endLine]`
 *   - kind ∈ NG_MEMBER_KINDS
 *
 * When several members share a name (rare — overloads, getter/setter pairs),
 * the first wins. Trace only needs one edge to surface the relationship.
 */
function buildOwnerMemberIndex(owner: Node, ctx: ResolutionContext): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const n of ctx.getNodesInFile(owner.filePath)) {
    if (!NG_MEMBER_KINDS.has(n.kind)) continue;
    if (n.startLine < owner.startLine || n.startLine > owner.endLine) continue;
    if (n.id === owner.id) continue;
    if (!map.has(n.name)) map.set(n.name, n);
  }
  return map;
}

/**
 * Extract distinct identifiers from a binding expression, dropping reserved
 * names, Angular template variables, and JS globals.
 */
function identifiersInExpression(expr: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  NG_IDENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NG_IDENT_RE.exec(expr)) !== null) {
    const name = m[0];
    if (NG_TEMPLATE_STOP_WORDS.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 4: Router config — Routes / RouterModule.forRoot / provideRouter
// ---------------------------------------------------------------------------

/**
 * Match the `[` that opens a Routes array. We capture three shapes:
 *   const routes: Routes = [...]
 *   const routes: Route[] = [...]
 *   readonly routes: Routes = [...]   (class field)
 *
 * The trailing `[` is included in the match so the caller can hand the
 * balanced reader the right open-bracket position.
 */
const NG_CONST_ROUTES_RE = /(?:const|let|var|readonly|public|private|protected)\s+\w+\s*:\s*(?:Routes|Route\s*\[\s*\])\s*=\s*\[/g;

/**
 * `RouterModule.forRoot([...])` / `RouterModule.forChild([...])`.
 */
const NG_ROUTER_MODULE_RE = /RouterModule\s*\.\s*(?:forRoot|forChild)\s*\(\s*\[/g;

/**
 * Standalone-bootstrap routes: `provideRouter([...])`. Newer apps use this
 * instead of RouterModule.forRoot.
 */
const NG_PROVIDE_ROUTER_RE = /\bprovideRouter\s*\(\s*\[/g;

/**
 * Route fields whose value is an array of guard identifiers (class or
 * standalone-functional). Each entry becomes a route → guard reference.
 * `canLoad` is deprecated in favour of `canMatch` but still appears in
 * older configs — we accept both.
 */
const ROUTE_GUARD_FIELDS = [
  'canActivate',
  'canActivateChild',
  'canDeactivate',
  'canMatch',
  'canLoad',
] as const;

/**
 * Extract Angular route nodes and route→component / route→module references
 * from a TS file. Emitted shape mirrors nestjsResolver's per-route node so
 * the rest of the graph (route query, framework filters) treats them
 * uniformly.
 *
 * Coverage v1:
 *   - `{ path, component }`                                     → route + ref to component
 *   - `{ path, loadComponent: () => import('x').then(m=>m.X) }` → route + ref to X
 *   - `{ path, loadChildren:  () => import('x').then(m=>m.X) }` → route + ref to X
 *   - `{ path, redirectTo, pathMatch }`                          → route node (no target)
 *   - nested `children: [...]`                                   → recursed; child paths joined onto parent
 *
 * Known limits (left to v2 / explicit non-goals):
 *   - dynamic spread `{ ...COMMON_ROUTES, path: 'x' }` is read as one route (the spread is ignored)
 *   - canActivate / resolve / providers arrays are not modeled
 *   - `loadChildren: () => SomeModule` (legacy, no import()) is ignored
 */
function extractAngularRoutes(
  filePath: string,
  content: string
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const lang = detectLanguage(filePath);
  const safe = stripCommentsForRegex(content, lang);

  type ArraySource = { arrStart: number };
  const sources: ArraySource[] = [];

  const collect = (re: RegExp): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(safe)) !== null) {
      sources.push({ arrStart: m.index + m[0].length - 1 });
    }
  };
  collect(NG_CONST_ROUTES_RE);
  collect(NG_ROUTER_MODULE_RE);
  collect(NG_PROVIDE_ROUTER_RE);

  for (const src of sources) {
    const arr = readBalanced(safe, src.arrStart, '[', ']');
    if (!arr) continue;
    // Pass the absolute position of the array's opening `[` so we can map
    // each route object back to a real line in the original source.
    processRouteArray(arr.inner, src.arrStart + 1, '', filePath, safe, nodes, references, now, lang);
  }

  return { nodes, references };
}

/**
 * Recursively walk a route-array body, emitting one route node per object
 * literal. `parentPath` is the joined path of the enclosing parent route
 * (used to compose nested URLs).
 *
 * `arrAbsStart` is the absolute index in `safe` of the FIRST character
 * inside `arrInner` (i.e. just past the opening `[`). That makes line
 * numbers exact rather than approximate.
 */
function processRouteArray(
  arrInner: string,
  arrAbsStart: number,
  parentPath: string,
  filePath: string,
  safe: string,
  nodes: Node[],
  references: UnresolvedRef[],
  now: number,
  lang: JsLang
): void {
  let i = 0;
  let inStr: string | null = null;
  while (i < arrInner.length) {
    const ch = arrInner[i]!;
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }
    if (ch !== '{') { i++; continue; }

    const parsed = readBalanced(arrInner, i, '{', '}');
    if (!parsed) { i++; continue; }
    const objStartInArr = i;
    const obj = arrInner.slice(i, parsed.end);
    const objAbsStart = arrAbsStart + objStartInArr;
    const line = lineAt(safe, objAbsStart);

    // path is optional in Angular routes (a parent matcher route without `path`
    // is rare but legal). Treat missing path as ''.
    const pathRaw = extractFieldString(obj, 'path');
    const subPath = pathRaw ?? '';
    const fullPath = joinRoutePath(parentPath, subPath);

    const node: Node = {
      id: `route:${filePath}:${line}:${fullPath}`,
      kind: 'route',
      name: fullPath || '/',
      qualifiedName: `${filePath}::route:${fullPath || '/'}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: obj.length,
      language: lang,
      updatedAt: now,
    };
    nodes.push(node);

    // Direct component target: `component: FooComponent`.
    const comp = extractFieldIdent(obj, 'component');
    if (comp) {
      references.push({
        fromNodeId: node.id,
        referenceName: comp,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: lang,
      });
    }

    // Lazy targets — module or standalone component.
    for (const field of ['loadChildren', 'loadComponent'] as const) {
      const target = extractLazyImportTarget(obj, field);
      if (target) {
        references.push({
          fromNodeId: node.id,
          referenceName: target,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }

    // Guards: `canActivate: [Guard1, Guard2]`, `canMatch: [...]`, etc. Each
    // entry is a guard class (or a function for Angular's standalone functional
    // guards). We don't distinguish — both resolve to a node by name.
    for (const guardField of ROUTE_GUARD_FIELDS) {
      const guards = extractFieldArrayIdentifiers(obj, guardField);
      for (const name of guards) {
        references.push({
          fromNodeId: node.id,
          referenceName: name,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }

    // Resolvers: `resolve: { user: UserResolver, role: RoleResolver }`. The
    // values are resolver classes / functions. Keys are local route-data names
    // and aren't useful as references — only the values are.
    for (const resolverName of extractFieldObjectValueIdentifiers(obj, 'resolve')) {
      references.push({
        fromNodeId: node.id,
        referenceName: resolverName,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: lang,
      });
    }

    // Recurse into `children: [...]` if present, joining the parent path.
    const childrenArrStart = locateArrayFieldOpen(obj, 'children');
    if (childrenArrStart >= 0) {
      const childrenArr = readBalanced(obj, childrenArrStart, '[', ']');
      if (childrenArr) {
        // `obj` is `arrInner.slice(i, parsed.end)`, so positions in `obj`
        // map back into `safe` via `objAbsStart + posInObj`.
        const childrenAbsStart = objAbsStart + childrenArrStart + 1;
        processRouteArray(
          childrenArr.inner,
          childrenAbsStart,
          fullPath,
          filePath,
          safe,
          nodes,
          references,
          now,
          lang,
        );
      }
    }

    i = parsed.end;
  }
}

/**
 * Locate the `[` that opens the value of a `fieldName: [...]` field at the
 * top level of an object literal. Returns the absolute index of `[` in the
 * input string, or -1 when the field is absent / its value isn't an array.
 */
function locateArrayFieldOpen(args: string, fieldName: string): number {
  const body = unwrapObjectLiteral(args);
  // We need positions in `args`, not `body` — when unwrap is a no-op they're
  // the same; when it strips an outer brace, the offset shifts by the index
  // of `{` plus 1. Compute that shift once.
  const shift = body === args ? 0 : args.indexOf('{') + 1;
  const fieldIdx = locateField(body, fieldName);
  if (fieldIdx < 0) return -1;
  let i = fieldIdx;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== ':') return -1;
  i++;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== '[') return -1;
  return shift + i;
}

/**
 * Read `fieldName: { k1: V1, k2: V2 }` at the top level of an object literal
 * and return the bare identifiers of the values. Used for `resolve: { user:
 * UserResolver }` in Angular route configs — keys are local data names,
 * values are the resolver classes (or functions) that need to become edge
 * targets.
 *
 * Non-identifier values (string literals, inline functions, expressions)
 * are silently dropped.
 */
function extractFieldObjectValueIdentifiers(args: string, fieldName: string): string[] {
  const body = unwrapObjectLiteral(args);
  const fieldIdx = locateField(body, fieldName);
  if (fieldIdx < 0) return [];
  let i = fieldIdx;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== ':') return [];
  i++;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== '{') return [];
  const obj = readBalanced(body, i, '{', '}');
  if (!obj) return [];

  const out: string[] = [];
  for (const entry of splitTopLevel(obj.inner, ',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // `key: value` — slice past the first ':' that isn't inside a type
    // annotation in a fancy key (unusual but possible for computed keys).
    const colonIdx = findTopLevelColon(trimmed);
    if (colonIdx < 0) continue;
    const valueText = trimmed.slice(colonIdx + 1).trim();
    const m = valueText.match(/^([A-Za-z_$][\w$]*)/);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * Find the position of the first `:` at depth 0 of `s`. String-aware.
 * Returns -1 when there's no top-level colon.
 */
function findTopLevelColon(s: string): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/**
 * Read `fieldName: SomeIdent` at the top level of an object literal.
 * Returns the bare identifier or null. Used for `component: FooComponent`.
 */
function extractFieldIdent(args: string, fieldName: string): string | null {
  const body = unwrapObjectLiteral(args);
  const idx = locateField(body, fieldName);
  if (idx < 0) return null;
  let i = idx;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== ':') return null;
  i++;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  const rest = body.slice(i);
  const m = rest.match(/^([A-Za-z_$][\w$]*)/);
  return m ? m[1]! : null;
}

/**
 * Extract the lazy-loaded module/component name from an Angular lazy field.
 * Handles the canonical dynamic-import shapes (the only forms Angular's own
 * docs and tooling produce):
 *
 *   loadChildren: () => import('./admin').then(m => m.AdminModule)
 *   loadComponent: () => import('./page').then(m => m.PageComponent)
 *   loadChildren: () => import('./admin').then(({ AdminModule }) => AdminModule)
 *   loadChildren: async () => (await import('./admin')).AdminModule
 *
 * The legacy string form (`loadChildren: 'path#Module'`) is dead in modern
 * Angular and intentionally not handled.
 */
function extractLazyImportTarget(args: string, fieldName: string): string | null {
  const body = unwrapObjectLiteral(args);
  const idx = locateField(body, fieldName);
  if (idx < 0) return null;
  let i = idx;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== ':') return null;
  i++;
  // Slice the value as a flat substring — value runs to the next top-level
  // comma or the end of the unwrapped body, whichever comes first.
  const tail = sliceUntilTopLevelComma(body, i);

  // Shape 1: `.then(m => m.NAME)` / `.then((m) => m.NAME)`
  const dotName = tail.match(/\.then\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\s*\.\s*([A-Za-z_$][\w$]*)/);
  if (dotName) return dotName[1]!;

  // Shape 2: `.then(({ NAME }) => NAME)` — destructured.
  const destructured = tail.match(/\.then\s*\(\s*\(?\s*\{\s*([A-Za-z_$][\w$]*)/);
  if (destructured) return destructured[1]!;

  // Shape 3: `(await import('...')).NAME` — async/await form.
  const awaited = tail.match(/\)\s*\.\s*([A-Za-z_$][\w$]*)/);
  if (awaited) return awaited[1]!;

  return null;
}

/**
 * Return the substring of `body` from `start` up to the next top-level
 * comma (or the end of body). String/bracket-aware so commas inside
 * arrow-function arg lists or string literals don't terminate early.
 */
function sliceUntilTopLevelComma(body: string, start: number): string {
  let depth = 0;
  let inStr: string | null = null;
  let i = start;
  while (i < body.length) {
    const ch = body[i]!;
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) return body.slice(start, i);
    i++;
  }
  return body.slice(start);
}

/**
 * Compose a parent route path and a child path into one URL.
 * - Empty child → return the parent (or `/` if parent is empty).
 * - Absolute child (`/admin`) → replace parent entirely.
 * - Relative child → `parent + '/' + child`, normalising slashes.
 */
function joinRoutePath(parent: string, sub: string): string {
  const cleanSub = sub.trim();
  if (cleanSub.startsWith('/')) return cleanSub.replace(/\/{2,}/g, '/');
  const left = parent.replace(/\/+$/, '');
  const right = cleanSub.replace(/^\/+/, '');
  if (!right) return left || (parent === '' ? '' : '/');
  return left ? `${left}/${right}` : `/${right}`;
}

// ---------------------------------------------------------------------------
// Selector & template-owner indices (consumed by phases 2 & 3 synthesizers)
// ---------------------------------------------------------------------------

/**
 * Map of selector string → component class node. Built by scanning every
 * @Component decorator's `selector:` field. Multi-selector strings
 * (`'app-foo, [appFoo]'`) are split and each variant indexed separately.
 *
 * Used by phase 2 (`<app-foo>` → ComponentClass synthesis) and reachable
 * from any synthesizer that has a `ResolutionContext`.
 */
export interface AngularSelector {
  /** Original selector exactly as it appeared in the metadata. */
  raw: string;
  /** Component class node this selector belongs to. */
  owner: Node;
  /** Lookup key used by angularSelectorEdges. */
  key: string;
  /** Element-style selector ('app-foo') if applicable. */
  tag?: string;
  /** Attribute-style selector ('appFoo') if applicable. */
  attribute?: string;
  /** Class-style selector ('anticon') if applicable. */
  className?: string;
}

export function buildAngularSelectorIndex(
  ctx: ResolutionContext
): Map<string, AngularSelector> {
  const index = new Map<string, AngularSelector>();

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    const content = ctx.readFile(file);
    // Directives use the same selector mechanism as components, just a
    // different decorator name. Gate on either to avoid scanning every TS
    // file in a monorepo.
    if (!content || (!content.includes('@Component(') && !content.includes('@Directive('))) continue;

    const safe = stripCommentsForRegex(content, 'typescript');
    const fileNodes = ctx.getNodesInFile(file);

    for (const hit of findClassDecorators(safe, ['Component', 'Directive'])) {
      const selectorRaw = extractFieldString(hit.args, 'selector');
      if (!selectorRaw) continue;
      const cls = classAfterDecorator(safe, hit.end);
      if (!cls) continue;
      const owner = fileNodes.find(
        (n) => n.name === cls.className && TARGET_KINDS.has(n.kind)
      );
      if (!owner) continue;

      for (const entry of selectorEntriesForVariant(selectorRaw, owner)) {
        index.set(entry.key, entry);
      }
    }
  }

  return index;
}

/**
 * Map of template file path (relative to project root) → owning component
 * class node. Built from every @Component decorator's `templateUrl:`.
 * Inline templates aren't keyed here — they're handled directly during
 * template scanning (their owner is in the same file).
 */
export function buildAngularTemplateOwnerIndex(
  ctx: ResolutionContext
): Map<string, Node> {
  const index = new Map<string, Node>();
  const projectRoot = ctx.getProjectRoot();

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('@Component(')) continue;

    const safe = stripCommentsForRegex(content, 'typescript');
    const fileNodes = ctx.getNodesInFile(file);

    for (const hit of findClassDecorators(safe, ['Component'])) {
      const templateUrl = extractFieldString(hit.args, 'templateUrl');
      if (!templateUrl) continue;
      const cls = classAfterDecorator(safe, hit.end);
      if (!cls) continue;
      const owner = fileNodes.find(
        (n) => n.name === cls.className && TARGET_KINDS.has(n.kind)
      );
      if (!owner) continue;

      const resolved = resolveTemplatePath(file, templateUrl, projectRoot);
      if (resolved) index.set(resolved, owner);
    }
  }

  return index;
}

/**
 * For each `@Component` decorator across the project, return its template
 * (inline or external) paired with the owning class node. This is the shared
 * input to phases 2 (selector → component edges) and 3 (template → handler
 * edges).
 *
 * Returns `null` for templates that couldn't be obtained (computed templates
 * — `template: getTpl()` — or external files that don't exist) by dropping
 * them silently. Half-bridged edges are worse than none.
 */
export function collectComponentTemplates(ctx: ResolutionContext): Array<{
  owner: Node;
  template: string;
  /** TS file path the @Component decorator lives in. */
  ownerFile: string;
  /** Where the template lives — same as ownerFile for inline, .html path for templateUrl. */
  templateSource: string;
}> {
  const out: Array<{ owner: Node; template: string; ownerFile: string; templateSource: string }> = [];
  const projectRoot = ctx.getProjectRoot();

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('@Component(')) continue;

    const safe = stripCommentsForRegex(content, 'typescript');
    const fileNodes = ctx.getNodesInFile(file);

    for (const hit of findClassDecorators(safe, ['Component'])) {
      const cls = classAfterDecorator(safe, hit.end);
      if (!cls) continue;
      const owner = fileNodes.find(
        (n) => n.name === cls.className && TARGET_KINDS.has(n.kind)
      );
      if (!owner) continue;

      // Prefer inline template (closer to handler, same file). Fall back to templateUrl.
      const inline = extractFieldString(hit.args, 'template');
      if (inline !== null) {
        out.push({ owner, template: inline, ownerFile: file, templateSource: file });
        continue;
      }
      const templateUrl = extractFieldString(hit.args, 'templateUrl');
      if (templateUrl) {
        const resolved = resolveTemplatePath(file, templateUrl, projectRoot);
        const tpl = ctx.readFile(resolved);
        if (tpl !== null) {
          out.push({ owner, template: tpl, ownerFile: file, templateSource: resolved });
        }
      }
    }
  }

  return out;
}

/**
 * Resolve a templateUrl (typically relative, `./foo.component.html`) to a
 * project-relative path. We work in project-relative paths everywhere so the
 * result matches `ctx.getAllFiles()` / `ctx.readFile()` expectations.
 */
function resolveTemplatePath(
  componentFile: string,
  templateUrl: string,
  _projectRoot: string
): string {
  // Normalize separators; we operate in project-relative space.
  const norm = componentFile.replace(/\\/g, '/');
  const url = templateUrl.replace(/\\/g, '/');
  if (url.startsWith('/')) return url.replace(/^\/+/, '');
  const dir = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
  const parts = (dir ? dir + '/' + url : url).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out.join('/');
}

// ---------------------------------------------------------------------------
// Decorator scanning (regex-over-source, balanced-paren args)
// ---------------------------------------------------------------------------

interface DecoratorHit {
  /** Decorator name without the leading `@`. */
  name: string;
  /** Raw text between the decorator's parentheses. */
  args: string;
  /** Index of the leading `@` in the (comment-stripped) source. */
  index: number;
  /** Index just past the decorator's closing `)`. */
  end: number;
}

/**
 * Find every `@Name(...)` whose name is in `names`. Balanced-paren reader
 * handles type thunks (`@Inject(() => FooToken)`) and nested object/array
 * literals in the args without truncating early.
 */
function findClassDecorators(
  safe: string,
  names: readonly string[]
): DecoratorHit[] {
  const hits: DecoratorHit[] = [];
  const re = new RegExp(`@(${names.join('|')})\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(safe)) !== null) {
    const openIndex = m.index + m[0].length - 1;
    const parsed = readBalanced(safe, openIndex, '(', ')');
    if (!parsed) continue;
    hits.push({
      name: m[1]!,
      args: parsed.inner,
      index: m.index,
      end: parsed.end,
    });
    re.lastIndex = parsed.end;
  }
  return hits;
}

/**
 * Read a balanced `(...)` / `[...]` / `{...}` starting at `openIndex` (which
 * must point at the opening delimiter). String-aware so delimiters inside
 * string literals (including template literals) don't unbalance the count.
 * Returns the inner text and the index just past the closing delimiter.
 */
function readBalanced(
  s: string,
  openIndex: number,
  open: string,
  close: string
): { inner: string; end: number } | null {
  if (s[openIndex] !== open) return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIndex; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { inner: s.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Starting just after a class decorator's `)`, skip any stacked decorators
 * (`@Stage1() @Stage2()`), `export`, `default`, and `abstract` modifiers,
 * then locate the `class Identifier` keyword pair. Returns the class name +
 * its source line (1-indexed) + the start index of the `class` token.
 *
 * Returns `null` when no class follows (e.g. function-style decorators we
 * don't care about, malformed source).
 */
function classAfterDecorator(
  safe: string,
  start: number
): { className: string; classLine: number; classStartIndex: number } | null {
  let i = start;
  const ws = /\s*/y;
  const decoName = /@[\w.]+/y;
  const modifier = /(?:export|default|abstract|declare)\b/y;
  const classKw = /class\s+([A-Za-z_$][\w$]*)/y;

  const eatWs = (): void => {
    ws.lastIndex = i;
    if (ws.exec(safe)) i = ws.lastIndex;
  };

  // Skip stacked decorators.
  for (;;) {
    eatWs();
    if (safe[i] !== '@') break;
    decoName.lastIndex = i;
    if (!decoName.exec(safe)) break;
    i = decoName.lastIndex;
    eatWs();
    if (safe[i] === '(') {
      const parsed = readBalanced(safe, i, '(', ')');
      if (!parsed) return null;
      i = parsed.end;
    }
  }

  // Skip export / default / abstract / declare.
  for (;;) {
    eatWs();
    modifier.lastIndex = i;
    if (modifier.exec(safe) && modifier.lastIndex > i) {
      i = modifier.lastIndex;
      continue;
    }
    break;
  }

  eatWs();
  classKw.lastIndex = i;
  const m = classKw.exec(safe);
  if (!m) return null;

  const classStartIndex = m.index;
  const className = m[1]!;
  const classLine = lineAt(safe, classStartIndex);
  return { className, classLine, classStartIndex };
}

// ---------------------------------------------------------------------------
// Argument value extraction
// ---------------------------------------------------------------------------

/**
 * From a decorator args string, locate `fieldName: [...]` and return the bare
 * identifiers in that array. Handles:
 *   - bare identifiers:         `[Foo, Bar]`
 *   - `{ provide: X, useClass: Baz }` → returns `Baz` (preferred) or `X`
 *   - `{ provide: X, useValue: ... }` → returns `X` (no class target)
 *   - `forRoot(...)` calls       → returns the callee name (`SharedModule`)
 *   - nested expressions / spreads → skipped silently
 *
 * Top-level comma splitting is bracket-aware so nested arrays/objects don't
 * trip the split.
 */
export function extractFieldArrayIdentifiers(
  args: string,
  fieldName: string
): string[] {
  const body = unwrapObjectLiteral(args);
  const fieldStart = locateField(body, fieldName);
  if (fieldStart < 0) return [];

  let i = fieldStart;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== ':') return [];
  i++;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== '[') return [];

  const arr = readBalanced(body, i, '[', ']');
  if (!arr) return [];

  return splitTopLevel(arr.inner, ',')
    .map((part) => identifierFromArrayElement(part.trim()))
    .filter((id): id is string => id !== null);
}

/**
 * Locate `fieldName:` at depth 0 of `body`. Returns the index just past
 * `fieldName` (so the caller scans `:` + value) or -1. Pure function —
 * callers that want object-literal-aware behavior must call
 * `unwrapObjectLiteral` first and search the unwrapped body.
 */
function locateField(body: string, fieldName: string): number {
  const pat = new RegExp(`\\b${fieldName}\\s*:`, 'g');
  let m: RegExpExecArray | null;
  while ((m = pat.exec(body)) !== null) {
    if (depthAt(body, m.index) === 0) {
      return m.index + fieldName.length;
    }
  }
  return -1;
}

/**
 * Unwrap a single outer `{...}` so callers can search at depth 0. Idempotent
 * on non-object args (returns the original). Refuses to unwrap when there's
 * trailing content after the closing brace (would change meaning).
 */
function unwrapObjectLiteral(args: string): string {
  const trimmed = args.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return args;
  const start = args.indexOf('{');
  const parsed = readBalanced(args, start, '{', '}');
  if (!parsed) return args;
  if (args.slice(parsed.end).trim() !== '') return args;
  return parsed.inner;
}

/**
 * Compute brace/bracket/paren nesting depth at `index` in `s`. String-aware.
 */
function depthAt(s: string, index: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < index; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
  }
  return depth;
}

/**
 * Split a string on `sep` at top-level only (depth-0 wrt brackets/braces/
 * parens). String-aware. Empty parts dropped by the caller via `.trim()`.
 */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(s.slice(last, i));
      last = i + 1;
    }
  }
  out.push(s.slice(last));
  return out;
}

/**
 * Pull a class-target identifier from one element of a metadata array.
 *
 * Shapes handled:
 *   `Foo`                              → "Foo"
 *   `Foo.forRoot(config)`              → "Foo"           (module call shape)
 *   `Foo.forChild(routes)`             → "Foo"
 *   `{ provide: X, useClass: Bar }`    → "Bar"           (DI provider shape)
 *   `{ provide: X, useExisting: Bar }` → "Bar"
 *   `{ provide: X, useValue: ... }`    → "X"             (token only)
 *   `{ provide: X, useFactory: fn }`   → "X"             (factory not modeled)
 *   `...COMMON_DECLARATIONS`           → null            (spreads punted)
 *   `someCondition ? A : B`            → null            (conditionals punted)
 */
function identifierFromArrayElement(part: string): string | null {
  if (!part) return null;
  // Spread: `...Foo`.
  if (part.startsWith('...')) return null;
  // Conditional / ternary or other expression — punt.
  if (/[?<>=!&|+\-*/]/.test(part) && !/^\{/.test(part)) {
    // Bare identifier possibly followed by dot-method call gets a pass.
    if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*\s*\(.*\))?$/.test(part)) return null;
  }
  // Provider object shape: { provide: X, useClass|useExisting: Y } prefer Y.
  if (part.startsWith('{')) {
    const inner = part.slice(1, part.lastIndexOf('}'));
    const useClass = matchFieldIdent(inner, 'useClass');
    if (useClass) return useClass;
    const useExisting = matchFieldIdent(inner, 'useExisting');
    if (useExisting) return useExisting;
    const provide = matchFieldIdent(inner, 'provide');
    if (provide) return provide;
    return null;
  }
  // Strip a trailing `.forRoot(...)` / `.forChild(...)` / `.withConfig(...)` etc.
  const dotCall = part.match(/^([A-Za-z_$][\w$]*)\s*\./);
  if (dotCall) return dotCall[1]!;
  // Plain identifier.
  const ident = part.match(/^([A-Za-z_$][\w$]*)$/);
  return ident ? ident[1]! : null;
}

/**
 * Inside a `{ ... }` literal, find `field: SomeIdent` and return `SomeIdent`.
 * Top-level (depth-0) only.
 */
function matchFieldIdent(inner: string, field: string): string | null {
  const fieldIdx = locateField(inner, field);
  if (fieldIdx < 0) return null;
  let i = fieldIdx;
  while (i < inner.length && /\s/.test(inner[i]!)) i++;
  if (inner[i] !== ':') return null;
  i++;
  while (i < inner.length && /\s/.test(inner[i]!)) i++;
  const m = inner.slice(i).match(/^([A-Za-z_$][\w$]*)/);
  return m ? m[1]! : null;
}

/**
 * Pull a string literal value out of `fieldName: 'x'` / `"x"` / `` `x` ``.
 * Top-level only. Returns null if not present or not a literal.
 */
export function extractFieldString(args: string, fieldName: string): string | null {
  const body = unwrapObjectLiteral(args);
  const fieldIdx = locateField(body, fieldName);
  if (fieldIdx < 0) return null;
  let i = fieldIdx;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== ':') return null;
  i++;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  const quote = body[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let j = i + 1;
  while (j < body.length) {
    if (body[j] === '\\') {
      j += 2;
      continue;
    }
    if (body[j] === quote) return body.slice(i + 1, j);
    j++;
  }
  return null;
}

function isStandaloneComponent(args: string): boolean {
  const body = unwrapObjectLiteral(args);
  const fieldIdx = locateField(body, 'standalone');
  if (fieldIdx < 0) {
    // Angular v17+ defaults standalone:true. Detect-by-imports-presence is a
    // reasonable proxy: if there's an `imports:` field at all, treat it as
    // standalone and emit edges. The worst case is a few extra edges on a
    // misclassified non-standalone Component, but a Component declaring
    // `imports` while not standalone is illegal anyway.
    return locateField(body, 'imports') >= 0;
  }
  let i = fieldIdx;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  if (body[i] !== ':') return false;
  i++;
  while (i < body.length && /\s/.test(body[i]!)) i++;
  return body.startsWith('true', i);
}

// ---------------------------------------------------------------------------
// Selector parsing (CSS-like, Angular subset)
// ---------------------------------------------------------------------------

/**
 * Split a comma-separated selector list at top level. Mirrors CSS selector
 * list parsing — Angular selectors are CSS-like.
 */
function splitSelectorList(selector: string): string[] {
  return splitTopLevel(selector, ',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Element-style selector — `app-foo`. Returns the bare tag name only for
 * simple element selectors. Compound directive selectors (`a[href]`,
 * `i.anticon`) need tag+attribute/class matching; treating them as plain
 * tags massively over-links common HTML elements.
 */
function extractTagFromSelector(selector: string): string | null {
  const trimmed = selector.trim();
  const m = trimmed.match(/^([a-z][a-z0-9-]*)$/i);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Attribute-style selector — `[appFoo]`, `button[appFoo]`. Returns the
 * attribute name (without brackets) or `null`.
 */
function extractAttributeFromSelector(selector: string): string | null {
  const m = selector.match(/\[([a-z][a-z0-9-]*)\]/i);
  return m ? m[1]! : null;
}

function selectorEntriesForVariant(selectorRaw: string, owner: Node): AngularSelector[] {
  const entries: AngularSelector[] = [];

  for (const variant of splitSelectorList(selectorRaw)) {
    const selector = variant.trim();
    if (!selector || /:not\b|[>+~\s]/.test(selector)) continue;

    const plainTag = selector.match(/^([a-z][a-z0-9-]*)$/i);
    if (plainTag) {
      const tag = plainTag[1]!.toLowerCase();
      entries.push({ raw: variant, owner, key: `tag:${tag}`, tag });
      continue;
    }

    const pureAttribute = selector.match(/^\[([a-z][a-z0-9-]*)\]$/i);
    if (pureAttribute) {
      const attribute = pureAttribute[1]!;
      entries.push({ raw: variant, owner, key: `attr:${attribute}`, attribute });
      continue;
    }

    const tagAttribute = selector.match(/^([a-z][a-z0-9-]*)\[([a-z][a-z0-9-]*)\]$/i);
    if (tagAttribute) {
      const tag = tagAttribute[1]!.toLowerCase();
      const attribute = tagAttribute[2]!;
      entries.push({
        raw: variant,
        owner,
        key: `tagattr:${tag}[${attribute}]`,
        tag,
        attribute,
      });
      continue;
    }

    const tagClass = selector.match(/^([a-z][a-z0-9-]*)\.([a-z][a-z0-9_-]*)$/i);
    if (tagClass) {
      const tag = tagClass[1]!.toLowerCase();
      const className = tagClass[2]!;
      entries.push({
        raw: variant,
        owner,
        key: `tagclass:${tag}.${className}`,
        tag,
        className,
      });
    }
  }

  return entries;
}

function parseTemplateTagAttributes(attrText: string): {
  attrs: Set<string>;
  classes: Set<string>;
} {
  const attrs = new Set<string>();
  const classes = new Set<string>();

  NG_TEMPLATE_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NG_TEMPLATE_ATTR_RE.exec(attrText)) !== null) {
    const attr = m[1] || m[2];
    if (!attr) continue;
    attrs.add(attr);

    if (attr === 'class') {
      const classValue = m[3] || m[4] || '';
      NG_CLASS_RE.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = NG_CLASS_RE.exec(classValue)) !== null) {
        classes.add(cm[0]);
      }
    }
  }

  return { attrs, classes };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function lineAt(safe: string, index: number): number {
  return safe.slice(0, index).split('\n').length;
}

function detectLanguage(filePath: string): JsLang {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript';
  return 'javascript';
}

// Re-exported for unit tests so individual helpers can be exercised without
// going through the full ctx-driven synthesizer path.
export const __internal = {
  detectLanguage,
  findClassDecorators,
  classAfterDecorator,
  extractFieldArrayIdentifiers,
  extractFieldString,
  extractFieldIdent,
  extractFieldObjectValueIdentifiers,
  extractLazyImportTarget,
  isStandaloneComponent,
  resolveTemplatePath,
  splitSelectorList,
  extractTagFromSelector,
  extractAttributeFromSelector,
  selectorEntriesForVariant,
  parseTemplateTagAttributes,
  readBalanced,
  joinRoutePath,
  NG_MODULE_ARRAY_FIELDS,
  ROUTE_GUARD_FIELDS,
};
