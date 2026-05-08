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
      const [, method, routePath, _controller, action] = match;
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
        referenceName: action!,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'ruby',
      });
    }

    return { nodes, references };
  },
};

// Helper functions

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
