/**
 * Ruby Framework Resolver
 *
 * Handles Ruby on Rails patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, FrameworkExtractionResult, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

/**
 * A `resources` line's `only:` / `except:` action list, written any way Rails
 * accepts it: `[:index, :show]`, `:show`, `%i[new create index]`, `%w(index
 * show)`, `"show"`, or the older `:only => [...]`. Null when the option is
 * absent. maybe's `only: %i[new create index]` was not read, so every
 * resource drew all seven routes, four of them to actions that do not exist.
 */
function railsActionOption(tail: string, key: 'only' | 'except'): Set<string> | null {
  const m = new RegExp(
    String.raw`(?:\b${key}:|:${key}\s*=>)\s*(?:\[([^\]]*)\]|%[iIwW]\s*[\[(]([^\])]*)[\])]|:(\w+)|["'](\w+)["'])`
  ).exec(tail);
  if (!m) return null;
  if (m[1] !== undefined) {
    return new Set(m[1].split(',').map((v) => v.trim().replace(/^:/, '').replace(/^["']|["']$/g, '')).filter(Boolean));
  }
  if (m[2] !== undefined) return new Set(m[2].trim().split(/\s+/).filter(Boolean));
  return new Set([m[3] ?? m[4]!]);
}

export const railsResolver: FrameworkResolver = {
  name: 'rails',
  languages: ['ruby'],

  // `controller#action` route refs name no declared symbol, so resolveOne's
  // pre-filter would drop them before resolve() runs. Claim them (like the django
  // `_iterable_class` hook) so they reach Pattern 0.
  claimsReference(name: string): boolean {
    return /^[\w/]+#\w+$/.test(name);
  },

  detect(context: ResolutionContext): boolean {
    // Check for Gemfile with rails
    const gemfile = context.readFile('Gemfile');
    if (gemfile && /\bgem\s+["'](?:rails|railties)["']/.test(gemfile)) {
      return true;
    }

    // Check for config/application.rb (Rails signature)
    if (context.fileExists('config/application.rb')) {
      return true;
    }

    // Check for typical Rails directory structure — or a Rails engine's routes
    // file anywhere (solidus keeps each engine's under `backend/config/`).
    return (
      context.fileExists('app/controllers/application_controller.rb') ||
      context.fileExists('config/routes.rb') ||
      context.getAllFiles().some((f) => /(?:^|\/)config\/routes\.rb$/.test(f))
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 0: route action `controller#action` (from RESTful `resources` or an
    // explicit route) → the action method in that controller. Precise — avoids the
    // bare-`action` ambiguity (every controller has an `index`/`show`).
    const ca = ref.referenceName.match(/^([\w/]+)#(\w+)$/);
    if (ca) {
      const result = resolveControllerAction(ca[1]!, ca[2]!, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' };
      }
      return null;
    }

    // Pattern 1: Model references (ActiveRecord)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveModel(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveController(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Helper references
    if (ref.referenceName.endsWith('Helper')) {
      const result = resolveHelper(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Service/Job references
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Job')) {
      const result = resolveService(ref.referenceName, context);
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
    if (!filePath.endsWith('.rb')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'ruby');

    // A routes file is read with its blocks: `namespace`, `scope`, nested
    // `resources … do`, `member` / `collection`.
    if (/\broutes\.draw\b/.test(safe) || /(?:^|\/)config\/routes\//.test(filePath)) {
      return extractScopedRailsRoutes(filePath, safe);
    }

    // get/post/put/patch/delete/match '/path', to: 'controller#action'
    // Also: get '/path' => 'controller#action'
    const routeRegex = /\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]\s*(?:,\s*to:\s*|=>\s*)['"]([^#'"]+)#([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, method, routePath, ctrl, action] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const upper = method!.toUpperCase();
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
        language: 'ruby',
        updatedAt: now,
      };
      nodes.push(routeNode);

      references.push({
        fromNodeId: routeNode.id,
        referenceName: `${ctrl}#${action}`, // precise controller#action, not bare action
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'ruby',
      });
    }

    // RESTful resources: `resources :articles` / `resource :user` (the dominant
    // Rails routing) generate a controller action per REST verb. The old resolver
    // only saw explicit `get '/x' => 'c#a'` routes, so resource-routed apps had
    // ZERO route nodes. Expand each into its actions → `controller#action` refs.
    const resRegex = /\b(resources?)\s+:(\w+)([^\n]*)/g;
    while ((match = resRegex.exec(safe)) !== null) {
      const plural = match[1] === 'resources';
      const resName = match[2]!;
      const tail = match[3] || '';
      let actions = plural ? PLURAL_ACTIONS : SINGULAR_ACTIONS;
      const only = railsActionOption(tail, 'only');
      const except = railsActionOption(tail, 'except');
      if (only) actions = actions.filter((a) => only.has(a));
      else if (except) actions = actions.filter((a) => !except.has(a));
      // `resources :articles` → ArticlesController; `resource :user` → UsersController.
      const ctrl = plural ? resName : pluralize(resName);
      const line = safe.slice(0, match.index).split('\n').length;
      for (const action of actions) {
        const spec = RESTFUL_ROUTES[action]!;
        const path = spec.path(resName);
        const routeNode: Node = {
          id: `route:${filePath}:${line}:${spec.method}:${ctrl}#${action}`,
          kind: 'route',
          name: `${spec.method} ${path}`,
          qualifiedName: `${filePath}::route:${ctrl}#${action}`,
          filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length,
          language: 'ruby', updatedAt: now,
        };
        nodes.push(routeNode);
        references.push({
          fromNodeId: routeNode.id,
          referenceName: `${ctrl}#${action}`,
          referenceKind: 'references',
          line, column: 0, filePath, language: 'ruby',
        });
      }
    }

    return { nodes, references };
  },
};

// Helper functions

interface RailsFrame {
  kind: 'namespace' | 'scope' | 'resource' | 'member' | 'collection' | 'block';
  /** Path prefix routes written inside this frame get. */
  path: string;
  /** Controller module prefix (`admin/`). */
  module: string;
  /** For a resource: its controller, collection path and member path. */
  controller?: string;
  collectionPath?: string;
  memberPath?: string;
}

/**
 * A Rails routes file with its nesting: `namespace :admin` prefixes paths and
 * controllers (`/admin/zones` → `admin/zones#index`), `scope` its path and
 * module, a `resources :products do` block nests its children under
 * `/products/:product_id`, and `member` / `collection` blocks add
 * `/products/:id/preview` / `/products/search` actions. Each `do`, and each
 * `if` / `unless` / `case` / `begin` line, opens a frame an `end` closes.
 */
function extractScopedRailsRoutes(filePath: string, safe: string): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const seen = new Set<string>();
  const stack: RailsFrame[] = [{ kind: 'block', path: '', module: '' }];
  const top = () => stack[stack.length - 1]!;
  const join = (...parts: string[]) => ('/' + parts.join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  const sym = (s: string) => s.replace(/^:/, '').replace(/^["']|["']$/g, '');
  const option = (tail: string, key: string) => new RegExp(`\\b${key}:\\s*(:\\w+|["'][^"']*["'])`).exec(tail)?.[1];
  const emit = (method: string, path: string, target: string, line: number) => {
    const id = `route:${filePath}:${line}:${method}:${path}:${target}`;
    if (seen.has(id)) return;
    seen.add(id);
    nodes.push({
      id, kind: 'route', name: `${method} ${path}`, qualifiedName: `${filePath}::route:${target}`,
      filePath, startLine: line, endLine: line, startColumn: 0, endColumn: 0, language: 'ruby', updatedAt: now,
    });
    references.push({ fromNodeId: id, referenceName: target, referenceKind: 'references', line, column: 0, filePath, language: 'ruby' });
  };
  const lines = safe.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    let text = lines[i]!.trim();
    if (!text) continue;
    // A statement whose `[` / `(` continues on the next lines (`only: [\n :a,\n :b ]`).
    const open = (t: string) => (t.match(/[[(]/g)?.length ?? 0) - (t.match(/[\])]/g)?.length ?? 0);
    while (open(text) > 0 && i + 1 < lines.length && !/\bdo\s*(?:\|[^|]*\|)?\s*$/.test(text)) text += ' ' + lines[++i]!.trim();
    if (/^end\b/.test(text)) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const opens = /\bdo\s*(?:\|[^|]*\|)?\s*$/.test(text);
    const frame = top();
    let pushed: RailsFrame | null = null;
    let m: RegExpExecArray | null;
    if ((m = /^namespace\s+(:\w+|["'][\w/-]+["'])(.*)$/.exec(text))) {
      const name = sym(m[1]!);
      const custom = option(m[2]!, 'path');
      pushed = { kind: 'namespace', path: join(frame.path, custom !== undefined ? sym(custom) : name), module: `${frame.module}${name}/` };
    } else if ((m = /^scope\b\s*\(?\s*(.*?)\)?\s*(?:do\b.*)?$/.exec(text)) && opens) {
      const args = m[1]!;
      const lead = /^(["'])([^"']*)\1/.exec(args)?.[2];
      const pathOpt = option(args, 'path');
      const moduleOpt = option(args, 'module');
      const path = lead ?? (pathOpt ? sym(pathOpt) : '');
      pushed = { kind: 'scope', path: join(frame.path, path), module: moduleOpt ? `${frame.module}${sym(moduleOpt)}/` : frame.module };
    } else if ((m = /^(resources?)\s+:(\w+)(.*)$/.exec(text))) {
      const plural = m[1] === 'resources';
      const name = m[2]!;
      const tail = m[3]!;
      const segment = option(tail, 'path') ? sym(option(tail, 'path')!) : name;
      const controller = frame.module + (option(tail, 'controller') ? sym(option(tail, 'controller')!) : plural ? name : pluralize(name));
      const collectionPath = join(frame.path, segment);
      const memberPath = plural ? join(collectionPath, ':id') : collectionPath;
      let actions = plural ? PLURAL_ACTIONS : SINGULAR_ACTIONS;
      const only = railsActionOption(tail, 'only');
      const except = railsActionOption(tail, 'except');
      if (only) actions = actions.filter((a) => only.has(a));
      else if (except) actions = actions.filter((a) => !except.has(a));
      for (const action of actions) {
        const spec = RESTFUL_ROUTES[action]!;
        const path = action === 'index' || action === 'create' ? collectionPath
          : action === 'new' ? join(collectionPath, 'new')
          : action === 'edit' ? join(memberPath, 'edit') : memberPath;
        emit(spec.method, path, `${controller}#${action}`, line);
      }
      if (opens) {
        const nested = plural ? join(collectionPath, `:${singularize(name)}_id`) : collectionPath;
        pushed = { kind: 'resource', path: nested, module: frame.module, controller, collectionPath, memberPath };
      }
    } else if (/^member\b/.test(text) && opens) {
      pushed = { ...frame, kind: 'member' };
    } else if (/^collection\b/.test(text) && opens) {
      pushed = { ...frame, kind: 'collection' };
    } else if ((m = /^root\s*\(?\s*(?:to:\s*)?["']([\w/]+)#(\w+)["']/.exec(text))) {
      emit('GET', join(frame.path) || '/', `${frame.module}${m[1]}#${m[2]}`, line);
    } else if ((m = /^(get|post|put|patch|delete|match)\s*\(?\s*(:\w+|["'][^"']*["'])(.*)$/.exec(text))) {
      const method = m[1]!.toUpperCase() === 'MATCH' ? 'ANY' : m[1]!.toUpperCase();
      const raw = sym(m[2]!);
      const tail = m[3]!;
      const to = /(?:\bto:\s*|=>\s*)["']([\w/]+)#(\w+)["']/.exec(tail);
      const resource = stack.slice().reverse().find((f) => f.kind === 'resource' || f.kind === 'member' || f.kind === 'collection');
      if (to) {
        const base = frame.kind === 'member' ? frame.memberPath! : frame.kind === 'collection' ? frame.collectionPath! : frame.path;
        emit(method, join(base, raw), `${frame.module}${to[1]}#${to[2]}`, line);
      } else if (resource?.controller && /^[\w-]+$/.test(raw)) {
        const action = sym(option(tail, 'action') ?? raw).replace(/-/g, '_');
        const base = frame.kind === 'collection' ? resource.collectionPath! : resource.memberPath!;
        emit(method, join(base, raw), `${resource.controller}#${action}`, line);
      }
    }
    if (pushed) {
      if (opens) stack.push(pushed);
    } else if (opens || /^(?:if|unless|case|begin|while|until)\b/.test(text)) {
      stack.push({ ...frame, kind: 'block' });
    }
  }
  return { nodes, references };
}

/** Naive singularize for a resource's nested `:x_id` segment. */
function singularize(w: string): string {
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(ss|us)$/.test(w)) return w;
  if (/(x|ch|sh|ses)$/.test(w) && w.endsWith('es')) return w.slice(0, -2);
  return w.replace(/s$/, '');
}

// RESTful action → HTTP verb + path. `resources` gets all seven; a singular
// `resource` omits `index`.
const RESTFUL_ROUTES: Record<string, { method: string; path: (r: string) => string }> = {
  index:   { method: 'GET',    path: (r) => `/${r}` },
  create:  { method: 'POST',   path: (r) => `/${r}` },
  new:     { method: 'GET',    path: (r) => `/${r}/new` },
  show:    { method: 'GET',    path: (r) => `/${r}/:id` },
  edit:    { method: 'GET',    path: (r) => `/${r}/:id/edit` },
  update:  { method: 'PATCH',  path: (r) => `/${r}/:id` },
  destroy: { method: 'DELETE', path: (r) => `/${r}/:id` },
};
const PLURAL_ACTIONS = ['index', 'create', 'new', 'show', 'edit', 'update', 'destroy'];
const SINGULAR_ACTIONS = ['create', 'new', 'show', 'edit', 'update', 'destroy'];

/** Naive ActiveSupport-style pluralize — covers the common resource names. */
function pluralize(w: string): string {
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(w)) return w + 'es';
  return w + 's';
}

/** snake_case → CamelCase (`user_profiles` → `UserProfiles`). */
function camelize(s: string): string {
  return s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/** Resolve a `controller#action` route ref to the action method in that controller. */
function resolveControllerAction(ctrlPath: string, action: string, context: ResolutionContext): string | null {
  // Rails convention: `articles` → app/controllers/articles_controller.rb.
  const direct = `app/controllers/${ctrlPath}_controller.rb`;
  if (context.fileExists(direct)) {
    const m = context.getNodesInFile(direct).find((n) => (n.kind === 'method' || n.kind === 'function') && n.name === action);
    if (m) return m.id;
  }
  // Fall back: controller class by name, then the action method in its file —
  // only the ones whose path ends with the route's module path when there are
  // any (an engine's `spree/admin/zones_controller.rb` for `admin/zones`).
  const cls = camelize(ctrlPath.split('/').pop()!) + 'Controller';
  const suffix = `/${ctrlPath}_controller.rb`;
  const all = context.getNodesByName(cls).filter((n) => n.kind === 'class');
  // A controller of the route's own module that inherits the action is not
  // another module's same-named controller that defines it.
  const own = ctrlPath.includes('/') ? all.filter((n) => ('/' + n.filePath).endsWith(suffix)) : [];
  const classes = own.length > 0 ? own : all;
  for (const ctrl of classes) {
    const m = context.getNodesInFile(ctrl.filePath).find((n) => (n.kind === 'method' || n.kind === 'function') && n.name === action);
    if (m) return m.id;
  }
  return null;
}

function resolveModel(name: string, context: ResolutionContext): string | null {
  // Try direct file path lookup first (Rails convention: CamelCase -> snake_case.rb)
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const possiblePaths = [
    `app/models/${snakeName}.rb`,
    `app/models/concerns/${snakeName}.rb`,
  ];

  for (const modelPath of possiblePaths) {
    if (context.fileExists(modelPath)) {
      const nodes = context.getNodesInFile(modelPath);
      const modelNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (modelNode) {
        return modelNode.id;
      }
    }
  }

  // Fall back to name-based lookup
  const candidates = context.getNodesByName(name);
  const modelNode = candidates.find(
    (n) => n.kind === 'class' && n.filePath.includes('app/models/')
  );
  if (modelNode) return modelNode.id;

  return null;
}

function resolveController(name: string, context: ResolutionContext): string | null {
  // Try direct file path lookup first
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const possiblePaths = [
    `app/controllers/${snakeName}.rb`,
    `app/controllers/api/${snakeName}.rb`,
    `app/controllers/api/v1/${snakeName}.rb`,
  ];

  for (const controllerPath of possiblePaths) {
    if (context.fileExists(controllerPath)) {
      const nodes = context.getNodesInFile(controllerPath);
      const controllerNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (controllerNode) {
        return controllerNode.id;
      }
    }
  }

  // Fall back to name-based lookup
  const candidates = context.getNodesByName(name);
  const controllerNode = candidates.find(
    (n) => n.kind === 'class' && n.filePath.includes('controllers/')
  );
  if (controllerNode) return controllerNode.id;

  return null;
}

function resolveHelper(name: string, context: ResolutionContext): string | null {
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const helperPath = `app/helpers/${snakeName}.rb`;

  if (context.fileExists(helperPath)) {
    const nodes = context.getNodesInFile(helperPath);
    const helperNode = nodes.find(
      (n) => n.kind === 'module' && n.name === name
    );
    if (helperNode) {
      return helperNode.id;
    }
  }

  return null;
}

function resolveService(name: string, context: ResolutionContext): string | null {
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const possiblePaths = [
    `app/services/${snakeName}.rb`,
    `app/jobs/${snakeName}.rb`,
    `app/workers/${snakeName}.rb`,
  ];

  for (const servicePath of possiblePaths) {
    if (context.fileExists(servicePath)) {
      const nodes = context.getNodesInFile(servicePath);
      const serviceNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (serviceNode) {
        return serviceNode.id;
      }
    }
  }

  return null;
}
