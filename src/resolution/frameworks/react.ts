/**
 * React Framework Resolver
 *
 * Handles React and Next.js patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const reactResolver: FrameworkResolver = {
  name: 'react',

  detect(context: ResolutionContext): boolean {
    // Check for React in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react || deps.next || deps['react-native']) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .jsx/.tsx files
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Component references (PascalCase)
    if (isPascalCase(ref.referenceName) && !isBuiltInType(ref.referenceName)) {
      const result = resolveComponent(ref.referenceName, ref.filePath, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Hook references (use*)
    if (ref.referenceName.startsWith('use') && ref.referenceName.length > 3) {
      const result = resolveHook(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Context references
    if (ref.referenceName.endsWith('Context') || ref.referenceName.endsWith('Provider')) {
      const result = resolveContext(ref.referenceName, context);
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

    // Extract component definitions
    // function Component() or const Component = () =>
    const componentPatterns = [
      // Function components
      /(?:export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g,
      // Arrow function components
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_]*)\s*=>/g,
      // forwardRef components
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?forwardRef/g,
      // memo components
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?memo/g,
    ];

    for (const pattern of componentPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [fullMatch, name] = match;
        const line = content.slice(0, match.index).split('\n').length;

        // Check if it returns JSX (rough heuristic)
        const afterMatch = content.slice(match.index + fullMatch.length, match.index + fullMatch.length + 500);
        const hasJSX = afterMatch.includes('<') && (afterMatch.includes('/>') || afterMatch.includes('</'));

        if (hasJSX) {
          nodes.push({
            id: `component:${filePath}:${name}:${line}`,
            kind: 'component',
            name: name!,
            qualifiedName: `${filePath}::${name}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: fullMatch.length,
            language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
            isExported: fullMatch.includes('export'),
            updatedAt: now,
          });
        }
      }
    }

    // Extract custom hooks
    const hookPattern = /(?:export\s+)?(?:function|const|let)\s+(use[A-Z][a-zA-Z0-9]*)\s*[=(]/g;
    let hookMatch;
    while ((hookMatch = hookPattern.exec(content)) !== null) {
      const [fullMatch, name] = hookMatch;
      const line = content.slice(0, hookMatch.index).split('\n').length;

      nodes.push({
        id: `hook:${filePath}:${name}:${line}`,
        kind: 'function',
        name: name!,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: fullMatch.length,
        language: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript',
        isExported: fullMatch.includes('export'),
        updatedAt: now,
      });
    }

    // Extract Next.js pages/routes (pages directory convention)
    if (filePath.includes('pages/') || filePath.includes('app/')) {
      // Default export in pages becomes a route
      if (content.includes('export default')) {
        const routePath = filePathToRoute(filePath);
        if (routePath) {
          const line = content.indexOf('export default');
          const lineNum = content.slice(0, line).split('\n').length;

          nodes.push({
            id: `route:${filePath}:${routePath}:${lineNum}`,
            kind: 'route',
            name: routePath,
            qualifiedName: `${filePath}::route:${routePath}`,
            filePath,
            startLine: lineNum,
            endLine: lineNum,
            startColumn: 0,
            endColumn: 0,
            language: filePath.endsWith('.tsx') ? 'tsx' : filePath.endsWith('.ts') ? 'typescript' : 'javascript',
            updatedAt: now,
          });
        }
      }
    }

    return nodes;
  },
};

/**
 * Check if string is PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * Check if name is a built-in type
 */
function isBuiltInType(name: string): boolean {
  return BUILT_IN_TYPES.has(name);
}

const BUILT_IN_TYPES = new Set([
  'Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Math', 'Number',
  'Object', 'Promise', 'RegExp', 'String', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'React', 'Component', 'Fragment', 'Suspense', 'StrictMode',
]);

const COMPONENT_KINDS = new Set(['component', 'function', 'class']);

/**
 * Resolve a component reference using name-based lookup
 */
function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const components = candidates.filter((n) => COMPONENT_KINDS.has(n.kind));
  if (components.length === 0) return null;

  // Prefer same directory
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const sameDir = components.filter((n) => n.filePath.startsWith(fromDir));
  if (sameDir.length > 0) return sameDir[0]!.id;

  // Prefer component directories
  const COMPONENT_DIRS = ['/components/', '/src/components/', '/app/components/', '/pages/', '/src/pages/', '/views/', '/src/views/'];
  const preferred = components.filter((n) =>
    COMPONENT_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return components[0]!.id;
}

/**
 * Resolve a custom hook reference using name-based lookup
 */
function resolveHook(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const hooks = candidates.filter((n) => n.kind === 'function' && n.name.startsWith('use'));
  if (hooks.length === 0) return null;

  // Prefer hooks directories
  const HOOK_DIRS = ['/hooks/', '/src/hooks/', '/lib/hooks/', '/utils/hooks/'];
  const preferred = hooks.filter((n) =>
    HOOK_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return hooks[0]!.id;
}

/**
 * Resolve a context reference using name-based lookup
 */
function resolveContext(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) {
    // Try without Context/Provider suffix
    const baseName = name.replace(/Context$|Provider$/, '');
    if (baseName !== name) {
      const baseCandidates = context.getNodesByName(baseName);
      if (baseCandidates.length > 0) return baseCandidates[0]!.id;
    }
    return null;
  }

  // Prefer context directories
  const CONTEXT_DIRS = ['/context/', '/contexts/', '/src/context/', '/src/contexts/', '/providers/', '/src/providers/'];
  const preferred = candidates.filter((n) =>
    CONTEXT_DIRS.some((d) => n.filePath.includes(d))
  );
  if (preferred.length > 0) return preferred[0]!.id;

  return candidates[0]!.id;
}

/**
 * Convert file path to Next.js route
 */
function filePathToRoute(filePath: string): string | null {
  // pages/index.tsx -> /
  // pages/about.tsx -> /about
  // pages/blog/[slug].tsx -> /blog/:slug
  // app/page.tsx -> /
  // app/about/page.tsx -> /about

  if (filePath.includes('pages/')) {
    let route = filePath
      .replace(/^.*pages\//, '/')
      .replace(/\/index\.(tsx?|jsx?)$/, '')
      .replace(/\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  if (filePath.includes('app/')) {
    // App router - only page.tsx files are routes
    if (!filePath.includes('page.')) {
      return null;
    }

    let route = filePath
      .replace(/^.*app\//, '/')
      .replace(/\/page\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  return null;
}
