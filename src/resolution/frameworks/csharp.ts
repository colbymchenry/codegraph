/**
 * C# Framework Resolver
 *
 * Handles ASP.NET Core, ASP.NET MVC, and common C# patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const aspnetResolver: FrameworkResolver = {
  name: 'aspnet',
  languages: ['csharp'],

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

  extract(filePath, content) {
    if (!filePath.endsWith('.cs')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'csharp');

    // [HttpGet("path")], [HttpPost("path")], etc.
    const attrRegex = /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)\s*\(\s*"([^"]+)"\s*\)\]/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(safe)) !== null) {
      const [, verb, routePath] = match;
      const method = verb!.replace(/^Http/, '').toUpperCase();
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

      // Capture the next method declaration
      const tail = safe.slice(match.index + match[0].length);
      const methodMatch = tail.match(/(?:public|private|protected|internal)\s+[\w<>,\s\[\]]+?\s+(\w+)\s*\(/);
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: methodMatch[1]!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'csharp',
        });
      }
    }

    // Minimal APIs: app.MapGet("/path", handler)
    const minimalRegex = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"\s*,\s*([^,)]+)/g;
    while ((match = minimalRegex.exec(safe)) !== null) {
      const [, verb, routePath, handlerExpr] = match;
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

    return { nodes, references };
  },
};

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
