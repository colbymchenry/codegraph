/**
 * C# Framework Resolver
 *
 * Handles ASP.NET Core, ASP.NET MVC, and common C# patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { pickByNameAndKind } from './name-heuristic';
import { csharpTypeArityFits } from '../name-matcher';
import { aspnetAttributeRoutes, aspnetDeclaredTemplates, aspnetRoutePath } from './aspnet-routes';

export const aspnetResolver: FrameworkResolver = {
  name: 'aspnet',
  languages: ['csharp'],
  // A Razor page's `@model CheckoutModel` names the PageModel in the
  // code-behind beside it (`Checkout.cshtml.cs`); these rules look there first.
  resolveLanguages: ['csharp', 'razor'],

  detect(context: ResolutionContext): boolean {
    // Check for .csproj files with ASP.NET references
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.csproj')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('Microsoft.AspNetCore') ||
          content.includes('Microsoft.NET.Sdk.Web') ||
          content.includes('System.Web.Mvc')
        )) {
          return true;
        }
      }
    }

    // Check for Program.cs with WebApplication
    const programCs = context.readFile('Program.cs');
    if (programCs && (
      programCs.includes('WebApplication') ||
      programCs.includes('CreateHostBuilder') ||
      programCs.includes('UseStartup')
    )) {
      return true;
    }

    // Check for Startup.cs (ASP.NET Core signature)
    if (context.fileExists('Startup.cs')) {
      return true;
    }

    // ASP.NET signatures in controller/entrypoint SOURCE — covers feature-folder
    // apps with no `/Controllers/` dir and a subdir `Program.cs` that the
    // root-only checks above miss (e.g. realworld: Features/*/FooController.cs).
    // `.csproj` often isn't in the indexed source set, so source-scan is the
    // reliable signal.
    // Endpoint-group apps (`Endpoints/TodoItems.cs : IEndpointGroup`) have
    // none of those names: their files, and the extension that maps them, count.
    for (const file of allFiles) {
      if (!/(?:Controller|Program|Startup|Endpoints?|Extensions)\.cs$/.test(file) && !/(?:^|\/)Endpoints\/[^/]+\.cs$/.test(file)) continue;
      const c = context.readFile(file);
      if (c && (
        /\[(?:ApiController|Route|Http(?:Get|Post|Put|Patch|Delete))\b/.test(c) ||
        c.includes('ControllerBase') || c.includes(': Controller') ||
        c.includes('MapControllers') || c.includes('WebApplication') ||
        c.includes('Microsoft.AspNetCore') || c.includes('IEndpointGroup') ||
        c.includes('EndpointGroupBase') || c.includes('RouteGroupBuilder')
      )) return true;
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref, CLASS_KINDS, CONTROLLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Service references (dependency injection)
    if (ref.referenceName.endsWith('Service') || ref.referenceName.startsWith('I') && ref.referenceName.length > 1) {
      const result = resolveByNameAndKind(ref, SERVICE_KINDS, SERVICE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Repository references
    if (ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref, SERVICE_KINDS, REPO_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Model/Entity references
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref, CLASS_KINDS, MODEL_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 5: ViewModel references
    if (ref.referenceName.endsWith('ViewModel') || ref.referenceName.endsWith('Dto')) {
      const result = resolveByNameAndKind(ref, CLASS_KINDS, VIEWMODEL_DIRS, context);
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
    if (!filePath.endsWith('.cs')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'csharp');

    // Attribute routing: each controller's own `[Route]` templates (or its
    // base class's), each action's verb, `[AcceptVerbs]` and `[Route]`
    // attributes, and the route tokens, as ASP.NET Core reads them (#2905).
    const seen = new Set<string>();
    for (const r of aspnetAttributeRoutes(safe)) {
      const id = `route:${filePath}:${r.line}:${r.method}:${r.path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id,
        kind: 'route',
        name: `${r.method} ${r.path}`,
        // A controller that declares no template takes its base class's, which
        // postExtract reads once every file is in: the qualified name keeps
        // what the route is made of until then (inheritedControllerRoutes).
        qualifiedName: r.inherit
          ? `${filePath}::aspnet-base:${r.inherit.base}:${r.inherit.controller}:${r.inherit.action}:${r.method}:${JSON.stringify(r.inherit.template)}`
          : `${filePath}::route:${r.path}`,
        filePath,
        startLine: r.line,
        endLine: r.line,
        startColumn: 0,
        endColumn: r.length,
        language: 'csharp',
        updatedAt: now,
      });
      references.push({
        fromNodeId: id,
        referenceName: r.handler,
        referenceKind: 'references',
        line: r.line,
        column: 0,
        filePath,
        language: 'csharp',
      });
    }

    let match: RegExpExecArray | null;

    // Minimal APIs: app.MapGet("/path", handler)
    const minimalRegex = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"\s*,\s*([^,)]+)/g;
    while ((match = minimalRegex.exec(safe)) !== null) {
      const [, verb, rawPath, handlerExpr] = match;
      // `app.MapGet("api/todos", …)` serves `/api/todos`.
      const routePath = joinCsPath('', rawPath!);
      const method = verb!.toUpperCase();
      const line = safe.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'csharp',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handlerName = extractCSharpTailIdent(handlerExpr!);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'csharp',
        });
      }
    }

    // Minimal APIs, handler first — the endpoint-group idiom (Jason Taylor's
    // Clean Architecture template and its descendants):
    //
    //   public class TodoItems : IEndpointGroup {
    //     public static void Map(RouteGroupBuilder group) {
    //       group.MapPost(CreateTodoItem);
    //       group.MapPut(UpdateTodoItem, "{id}");
    //
    // The class is the group, the handler is the first argument, the path the
    // optional second. The group's prefix is the app's convention
    // (`$"/api/{groupName}"`, read repo-wide in postExtract) or the class's own
    // `RoutePrefix` literal; here the route is named under the class.
    const groupRegex = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*([A-Za-z_]\w*)\s*(?:,\s*"([^"]*)")?\s*\)/g;
    const routePrefixLiteral = /\bRoutePrefix\s*(?:=>|=)\s*"([^"]+)"/.exec(safe);
    while ((match = groupRegex.exec(safe)) !== null) {
      const [, verb, handlerName, sub] = match;
      const method = verb!.toUpperCase();
      const line = safe.slice(0, match.index).split('\n').length;
      const before = safe.slice(0, match.index);
      const classMatch = [...before.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)].pop();
      if (!classMatch) continue;
      const group = classMatch[1]!;
      const routePath = joinCsPath(routePrefixLiteral ? routePrefixLiteral[1]! : `/${group}`, sub ?? '');
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::group:${group}:${method}:${sub ?? ''}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'csharp',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerName!,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'csharp',
      });
    }

    // FastEndpoints: an endpoint class (`: Endpoint<TReq, TRes>`,
    // `EndpointWithoutRequest`, `Ep.Req<…>.Res<…>`) declares its verb and path in
    // `Configure()` — `Get("/Contributors")`, `Post(CreateContributorRequest.Route)`
    // — and handles the request in its own `HandleAsync` / `ExecuteAsync`. A
    // constant path (`X.Route`, usually in the request's own file) is read in
    // postExtract; until then the route is named by the expression.
    const endpointClass = /\bclass\s+([A-Za-z_]\w*)[^{;]*?:\s*(?:FastEndpoints\.)?(?:Endpoint(?:WithoutRequest|WithoutResponse)?\b|Ep\.)/g;
    while ((match = endpointClass.exec(safe)) !== null) {
      const body = safe.slice(match.index);
      const configure = /\bvoid\s+Configure\s*\(\s*\)\s*\{/.exec(body);
      if (!configure) continue;
      const handler = /\b(HandleAsync|ExecuteAsync)\s*\(/.exec(body)?.[1];
      const verbRegex = /\b(Get|Post|Put|Patch|Delete)\s*\(\s*([^;]*?)\s*\)\s*;/g;
      verbRegex.lastIndex = configure.index;
      const configureEnd = configure.index + 3000;
      let verb: RegExpExecArray | null;
      while ((verb = verbRegex.exec(body)) !== null && verb.index < configureEnd) {
        const method = verb[1]!.toUpperCase();
        const args = verb[2]!;
        // `$"/{nameof(Project)}s"` is `/Projects`.
        const literals = [...args.matchAll(/"([^"]+)"/g)].map((l) => joinCsPath('', l[1]!.replace(/\{\s*nameof\s*\(\s*(\w+)\s*\)\s*\}/g, '$1')));
        const constant = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(args);
        const targets = literals.length > 0 ? literals.map((p) => ({ name: p, key: p })) : constant ? [{ name: `${constant[1]}.${constant[2]}`, key: `const:${constant[1]}.${constant[2]}` }] : [];
        const line = safe.slice(0, match.index + verb.index).split('\n').length;
        for (const t of targets) {
          const id = `route:${filePath}:${line}:${method}:${t.name}`;
          nodes.push({
            id, kind: 'route', name: `${method} ${t.name}`,
            qualifiedName: `${filePath}::fastendpoint:${method}:${t.key}`,
            filePath, startLine: line, endLine: line, startColumn: 0, endColumn: 0, language: 'csharp', updatedAt: now,
          });
          if (handler) references.push({ fromNodeId: id, referenceName: handler, referenceKind: 'references', line, column: 0, filePath, language: 'csharp' });
        }
        // A second verb call (`Get(...); Post(...)`) is a second route; stop at Configure's end.
        if (/\n\s*\}\s*\n/.test(body.slice(configure.index, verb.index))) break;
      }
    }

    return { nodes, references };
  },

  /** Route names only the whole repository can give: FastEndpoints constant paths, endpoint-group prefixes, inherited controller templates. */
  postExtract(context: ResolutionContext): Node[] {
    return [...fastEndpointConstantRoutes(context), ...endpointGroupRoutes(context), ...inheritedControllerRoutes(context)];
  },
};

/** A route of a controller that declares no `[Route]` of its own: base, controller, action, verb, and the action's template as JSON. */
const INHERITED_ROUTE = /::aspnet-base:([A-Za-z_]\w*):([A-Za-z_]\w*):([A-Za-z_]\w*):([A-Z]+):(.*)$/;

/**
 * A controller with no `[Route]` of its own takes the templates of the
 * nearest base class that declares any — jellyfin's controllers derive from
 * `BaseJellyfinApiController`, whose `[Route("[controller]")]` names
 * `/Audio/{itemId}/stream` — wherever that base is declared. Only the first
 * such template names the route. Idempotent: the qualified name keeps what
 * the route is made of.
 */
function inheritedControllerRoutes(context: ResolutionContext): Node[] {
  const updates: Node[] = [];
  const templates = new Map<string, string | null>();
  for (const route of context.getNodesByKind('route')) {
    if (route.language !== 'csharp') continue;
    const q = INHERITED_ROUTE.exec(route.qualifiedName);
    if (!q) continue;
    const [, base, controller, action, method, json] = q;
    let actionTemplate: string | null;
    try {
      actionTemplate = JSON.parse(json!) as string | null;
    } catch {
      continue;
    }
    const template = inheritedTemplate(base!, context, templates, 0);
    if (template === null) continue;
    const name = `${method} ${aspnetRoutePath(template, actionTemplate, controller!, action!, null)}`;
    if (name !== route.name) updates.push({ ...route, name });
  }
  return updates;
}

/** The first `[Route]` template the C# class `name` passes to its subclasses: its own, or a base's (a few levels up). */
function inheritedTemplate(name: string, context: ResolutionContext, memo: Map<string, string | null>, depth: number): string | null {
  const hit = memo.get(name);
  if (hit !== undefined) return hit;
  // A cycle, or a lookup already under way, finds nothing.
  memo.set(name, null);
  let found: string | null = null;
  for (const decl of context.getNodesByName(name)) {
    if (decl.language !== 'csharp' || decl.kind !== 'class') continue;
    const content = context.readFile(decl.filePath);
    if (!content) continue;
    const declared = aspnetDeclaredTemplates(stripCommentsForRegex(content, 'csharp'), name);
    if (!declared) continue;
    if (declared.templates.length > 0) found = declared.templates[0]!;
    else if (declared.next && depth < 4) found = inheritedTemplate(declared.next, context, memo, depth + 1);
    if (found !== null) break;
  }
  memo.set(name, found);
  return found;
}

/**
 * A FastEndpoints route named by a constant (`Post(CreateContributorRequest.Route)`)
 * gets the constant's value: `public const string Route = "/Contributors";` in
 * that class, wherever it is declared. Idempotent — the qualified name keeps the
 * expression.
 */
function fastEndpointConstantRoutes(context: ResolutionContext): Node[] {
  const updates: Node[] = [];
  for (const route of context.getNodesByKind('route')) {
    if (route.language !== 'csharp') continue;
    const q = /::fastendpoint:([A-Z]+):const:([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(route.qualifiedName);
    if (!q) continue;
    const [, method, owner, field] = q;
    let value: string | null = null;
    for (const decl of context.getNodesByName(owner!)) {
      if (decl.language !== 'csharp' || (decl.kind !== 'class' && decl.kind !== 'struct')) continue;
      const text = context.readFile(decl.filePath) ?? '';
      const m = new RegExp(`\\b(?:const\\s+string|static\\s+readonly\\s+string|static\\s+string)\\s+${field}\\s*=\\s*"([^"]+)"`).exec(text);
      if (m) {
        value = m[1]!;
        break;
      }
    }
    if (!value) continue;
    const name = `${method} ${joinCsPath('', value)}`;
    if (name !== route.name) updates.push({ ...route, name });
  }
  return updates;
}

/**
 * The endpoint-group prefix convention, read once from the app: the
 * `MapGroup($"/api/{groupName}")` that registers every `IEndpointGroup`
 * (or `EndpointGroupBase`) under a head — `/api/` — before the class name.
 * A group route extracted as `POST /TodoItems` becomes `POST /api/TodoItems`;
 * a class with its own `RoutePrefix` literal already has its path. Idempotent:
 * `qualifiedName` keeps the group and the sub-path.
 */
function endpointGroupRoutes(context: ResolutionContext): Node[] {
  let head: string | null = null;
  let looked = 0;
  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.cs')) continue;
    const content = context.readFile(file);
    if (!content || !content.includes('MapGroup')) continue;
    if (++looked > 400) break;
    const m = /\$"([^"{]*)\{\s*(?:groupName|type\.Name|name|prefix)\s*\}"/.exec(content) ?? /MapGroup\(\s*\$"([^"{]*)\{/.exec(content);
    if (m) {
      head = m[1]!;
      break;
    }
  }
  if (!head || head === '/' || head === '') return [];
  const updates: Node[] = [];
  for (const route of context.getNodesByKind('route')) {
    if (route.language !== 'csharp') continue;
    const q = /::group:([A-Za-z_]\w*):([A-Z]+):(.*)$/.exec(route.qualifiedName);
    if (!q) continue;
    const content = context.readFile(route.filePath);
    if (content && /\bRoutePrefix\s*(?:=>|=)\s*"/.test(content)) continue;
    const name = `${q[2]} ${joinCsPath(head.replace(/\/+$/, '') + '/' + q[1], q[3]!)}`;
    if (name !== route.name) updates.push({ ...route, name });
  }
  return updates;
}

/** Join a class-level [Route] prefix and an action's path into one normalized `/path`. */
function joinCsPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

/** Extract last identifier from an expression like `MyService.Handler` or `Handler`. */
function extractCSharpTailIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\s+/g, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}

// Directory patterns
const CONTROLLER_DIRS = ['/Controllers/'];
const SERVICE_DIRS = ['/Services/', '/Service/', '/Application/'];
const REPO_DIRS = ['/Repositories/', '/Repository/', '/Data/', '/Infrastructure/'];
const MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Entity/', '/Domain/'];
const VIEWMODEL_DIRS = ['/ViewModels/', '/ViewModel/', '/DTOs/', '/Dto/'];

const CLASS_KINDS = new Set(['class']);
const SERVICE_KINDS = new Set(['class', 'interface']);

/** A framework name heuristic's pick (see name-heuristic.ts), preferring these folders. */
function resolveByNameAndKind(
  ref: UnresolvedRef,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const picked = pickByNameAndKind(ref, kinds, (f) => preferredDirPatterns.some((d) => f.includes(d)), context);
  const type = picked ? context.getNodeById?.(picked) : undefined;
  return type && !csharpTypeArityFits(type, ref, context) ? null : picked;
}
