/**
 * C# Framework Resolver
 *
 * Handles ASP.NET Core, ASP.NET MVC, and common C# patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const aspnetResolver: FrameworkResolver = {
  name: 'aspnet',

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

    // Check for Controllers directory
    return allFiles.some((f) => f.includes('/Controllers/') && f.endsWith('Controller.cs'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CONTROLLER_DIRS, context);
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
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, SERVICE_DIRS, context);
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
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, REPO_DIRS, context);
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
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, MODEL_DIRS, context);
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
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, VIEWMODEL_DIRS, context);
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

    // Extract route attributes
    // [HttpGet("path")], [HttpPost("path")], [Route("path")]
    const routePatterns = [
      /\[(Http(Get|Post|Put|Patch|Delete))\s*\(\s*["']([^"']+)["']\s*\)\]/g,
      /\[(Http(Get|Post|Put|Patch|Delete))\s*\]/g,
      /\[Route\s*\(\s*["']([^"']+)["']\s*\)\]/g,
    ];

    for (const pattern of routePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length;

        if (pattern.source.includes('Http')) {
          if (match[3]) {
            // HttpGet("path") style
            const [, , method, path] = match;
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
              language: 'csharp',
              updatedAt: now,
            });
          } else if (match[2]) {
            // HttpGet style without path
            const [, , method] = match;
            nodes.push({
              id: `route:${filePath}:${method!.toUpperCase()}:${line}`,
              kind: 'route',
              name: `${method!.toUpperCase()}`,
              qualifiedName: `${filePath}::${method!.toUpperCase()}`,
              filePath,
              startLine: line,
              endLine: line,
              startColumn: 0,
              endColumn: match[0].length,
              language: 'csharp',
              updatedAt: now,
            });
          }
        } else {
          // [Route("path")] style
          const [, path] = match;
          nodes.push({
            id: `route:${filePath}:ROUTE:${path}:${line}`,
            kind: 'route',
            name: `ROUTE ${path}`,
            qualifiedName: `${filePath}::ROUTE:${path}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            language: 'csharp',
            updatedAt: now,
          });
        }
      }
    }

    // Extract minimal API routes (ASP.NET Core 6+)
    // app.MapGet("/path", ...), app.MapPost("/path", ...)
    const minimalApiPattern = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*["']([^"']+)["']/g;

    let match;
    while ((match = minimalApiPattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;

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
        language: 'csharp',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Directory patterns
const CONTROLLER_DIRS = ['/Controllers/'];
const SERVICE_DIRS = ['/Services/', '/Service/', '/Application/'];
const REPO_DIRS = ['/Repositories/', '/Repository/', '/Data/', '/Infrastructure/'];
const MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Entity/', '/Domain/'];
const VIEWMODEL_DIRS = ['/ViewModels/', '/ViewModel/', '/DTOs/', '/Dto/'];

const CLASS_KINDS = new Set(['class']);
const SERVICE_KINDS = new Set(['class', 'interface']);

/**
 * Resolve a symbol by name using indexed queries instead of scanning all files.
 */
function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // Fall back to any match
  return kindFiltered[0]!.id;
}
