/**
 * Ruby Framework Resolver
 *
 * Handles Ruby on Rails patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const railsResolver: FrameworkResolver = {
  name: 'rails',

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

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract route definitions from config/routes.rb
    if (filePath.includes('routes.rb')) {
      // get/post/put/patch/delete 'path'
      const routePatterns = [
        /(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/g,
        /resources?\s+:(\w+)/g,
        /root\s+['"]([^'"]+)['"]/g,
        /root\s+to:\s*['"]([^'"]+)['"]/g,
      ];

      for (const pattern of routePatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const line = content.slice(0, match.index).split('\n').length;

          if (pattern.source.includes('resources')) {
            const [, resourceName] = match;
            nodes.push({
              id: `route:${filePath}:resource:${resourceName}:${line}`,
              kind: 'route',
              name: `resource:${resourceName}`,
              qualifiedName: `${filePath}::resource:${resourceName}`,
              filePath,
              startLine: line,
              endLine: line,
              startColumn: 0,
              endColumn: match[0].length,
              language: 'ruby',
              updatedAt: now,
            });
          } else if (pattern.source.includes('root')) {
            const [, target] = match;
            nodes.push({
              id: `route:${filePath}:root:${line}`,
              kind: 'route',
              name: `/ -> ${target}`,
              qualifiedName: `${filePath}::root`,
              filePath,
              startLine: line,
              endLine: line,
              startColumn: 0,
              endColumn: match[0].length,
              language: 'ruby',
              updatedAt: now,
            });
          } else {
            const [, method, path] = match;
            nodes.push({
              id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`,
              kind: 'route',
              name: `${method!.toUpperCase()} ${path}`,
              qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
              filePath,
              startLine: line,
              endLine: line,
              startColumn: 0,
              endColumn: match[0].length,
              language: 'ruby',
              updatedAt: now,
            });
          }
        }
      }
    }

    // Extract controller actions
    if (filePath.includes('controllers/') && filePath.endsWith('.rb')) {
      const actionPattern = /def\s+(\w+)/g;
      let match;
      while ((match = actionPattern.exec(content)) !== null) {
        const [, actionName] = match;
        const line = content.slice(0, match.index).split('\n').length;

        // Skip private methods and common Rails callbacks
        const privateMethods = ['initialize', 'set_', 'before_', 'after_'];
        if (!privateMethods.some((p) => actionName!.startsWith(p))) {
          nodes.push({
            id: `action:${filePath}:${actionName}:${line}`,
            kind: 'method',
            name: actionName!,
            qualifiedName: `${filePath}::${actionName}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            language: 'ruby',
            updatedAt: now,
          });
        }
      }
    }

    return nodes;
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
