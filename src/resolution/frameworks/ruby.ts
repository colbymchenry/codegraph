/**
 * Ruby Framework Resolver
 *
 * Handles Ruby on Rails patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

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
    if (gemfile && gemfile.includes("'rails'")) {
      return true;
    }

    // Check for config/application.rb (Rails signature)
    if (context.fileExists('config/application.rb')) {
      return true;
    }

    // Check for typical Rails directory structure
    return (
      context.fileExists('app/controllers/application_controller.rb') ||
      context.fileExists('config/routes.rb')
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
      const only = tail.match(/only:\s*\[([^\]]*)\]/);
      const except = tail.match(/except:\s*\[([^\]]*)\]/);
      const symList = (s: string) => new Set(s.split(',').map((x) => x.trim().replace(/^:/, '')));
      if (only) { const s = symList(only[1]!); actions = actions.filter((a) => s.has(a)); }
      else if (except) { const s = symList(except[1]!); actions = actions.filter((a) => !s.has(a)); }
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
  // Fall back: controller class by name, then the action method in its file.
  const cls = camelize(ctrlPath.split('/').pop()!) + 'Controller';
  for (const ctrl of context.getNodesByName(cls).filter((n) => n.kind === 'class')) {
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
