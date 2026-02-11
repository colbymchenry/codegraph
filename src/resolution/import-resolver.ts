/**
 * Import Resolver
 *
 * Resolves import paths to actual files and symbols.
 */

import * as path from 'path';
import { Language, Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext, ImportMapping } from './types';
import { normalizePath } from '../utils';

/**
 * Extension resolution order by language
 */
const EXTENSION_RESOLUTION: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '/index.js', '/index.jsx'],
  tsx: ['.tsx', '.ts', '.d.ts', '.js', '.jsx', '/index.tsx', '/index.ts', '/index.js'],
  jsx: ['.jsx', '.js', '/index.jsx', '/index.js'],
  python: ['.py', '/__init__.py'],
  go: ['.go'],
  rust: ['.rs', '/mod.rs'],
  java: ['.java'],
  csharp: ['.cs'],
  php: ['.php'],
  ruby: ['.rb'],
};

/**
 * Resolve an import path to an actual file
 */
export function resolveImportPath(
  importPath: string,
  fromFile: string,
  language: Language,
  context: ResolutionContext
): string | null {
  // Skip external/npm packages
  if (isExternalImport(importPath, language)) {
    return null;
  }

  const projectRoot = context.getProjectRoot();
  const fromDir = path.dirname(path.join(projectRoot, fromFile));

  // Handle relative imports
  if (importPath.startsWith('.')) {
    return resolveRelativeImport(importPath, fromDir, language, context);
  }

  // Handle absolute/aliased imports (like @/ or src/)
  return resolveAliasedImport(importPath, projectRoot, language, context);
}

/**
 * Check if an import is external (npm package, etc.)
 */
function isExternalImport(importPath: string, language: Language): boolean {
  // Relative imports are not external
  if (importPath.startsWith('.')) {
    return false;
  }

  // Common external patterns
  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx') {
    // Node built-ins
    if (['fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'util', 'events', 'stream', 'child_process', 'buffer'].includes(importPath)) {
      return true;
    }
    // Scoped packages or bare specifiers that don't start with aliases
    if (!importPath.startsWith('@/') && !importPath.startsWith('~/') && !importPath.startsWith('src/')) {
      // Likely an npm package
      return true;
    }
  }

  if (language === 'python') {
    // Standard library modules
    const stdLibs = ['os', 'sys', 'json', 're', 'math', 'datetime', 'collections', 'typing', 'pathlib', 'logging'];
    if (stdLibs.includes(importPath.split('.')[0]!)) {
      return true;
    }
  }

  if (language === 'go') {
    // Standard library or external packages
    if (!importPath.startsWith('.') && !importPath.includes('/internal/')) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve a relative import
 */
function resolveRelativeImport(
  importPath: string,
  fromDir: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const projectRoot = context.getProjectRoot();
  const extensions = EXTENSION_RESOLUTION[language] || [];

  // Try the path as-is first
  const basePath = path.resolve(fromDir, importPath);
  const relativePath = path.relative(projectRoot, basePath);

  // Normalize to forward slashes for cross-platform consistency
  const normalizedRelativePath = normalizePath(relativePath);

  // Try each extension
  for (const ext of extensions) {
    const candidatePath = normalizedRelativePath + ext;
    if (context.fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  // Try without extension (might already have one)
  if (context.fileExists(normalizedRelativePath)) {
    return normalizedRelativePath;
  }

  return null;
}

/**
 * Resolve an aliased/absolute import
 */
function resolveAliasedImport(
  importPath: string,
  _projectRoot: string,
  language: Language,
  context: ResolutionContext
): string | null {
  const extensions = EXTENSION_RESOLUTION[language] || [];

  // Common aliases
  const aliases: Record<string, string> = {
    '@/': 'src/',
    '~/': 'src/',
    '@src/': 'src/',
    'src/': 'src/',
    '@app/': 'app/',
    'app/': 'app/',
  };

  // Try each alias
  for (const [alias, replacement] of Object.entries(aliases)) {
    if (importPath.startsWith(alias)) {
      const resolvedPath = importPath.replace(alias, replacement);

      // Try with extensions
      for (const ext of extensions) {
        const candidatePath = resolvedPath + ext;
        if (context.fileExists(candidatePath)) {
          return candidatePath;
        }
      }

      // Try as-is
      if (context.fileExists(resolvedPath)) {
        return resolvedPath;
      }
    }
  }

  // Try direct path
  for (const ext of extensions) {
    const candidatePath = importPath + ext;
    if (context.fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

/**
 * Extract import mappings from a file
 */
export function extractImportMappings(
  _filePath: string,
  content: string,
  language: Language
): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  if (language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx') {
    mappings.push(...extractJSImports(content));
  } else if (language === 'python') {
    mappings.push(...extractPythonImports(content));
  } else if (language === 'go') {
    mappings.push(...extractGoImports(content));
  } else if (language === 'php') {
    mappings.push(...extractPHPImports(content));
  }

  return mappings;
}

/**
 * Extract JS/TS import mappings
 */
function extractJSImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // ES6 imports
  const importRegex = /import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*(?:(\*)\s+as\s+(\w+))?\s*from\s*['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const [, defaultImport, namedImports, star, namespaceAlias, source] = match;

    // Default import
    if (defaultImport) {
      mappings.push({
        localName: defaultImport,
        exportedName: 'default',
        source: source!,
        isDefault: true,
        isNamespace: false,
      });
    }

    // Named imports
    if (namedImports) {
      const names = namedImports.split(',').map((s) => s.trim());
      for (const name of names) {
        const aliasMatch = name.match(/(\w+)\s+as\s+(\w+)/);
        if (aliasMatch) {
          mappings.push({
            localName: aliasMatch[2]!,
            exportedName: aliasMatch[1]!,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        } else if (name) {
          mappings.push({
            localName: name,
            exportedName: name,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        }
      }
    }

    // Namespace import
    if (star && namespaceAlias) {
      mappings.push({
        localName: namespaceAlias,
        exportedName: '*',
        source: source!,
        isDefault: false,
        isNamespace: true,
      });
    }
  }

  // Require statements
  const requireRegex = /(?:const|let|var)\s+(?:(\w+)|{([^}]+)})\s*=\s*require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const [, defaultName, destructured, source] = match;

    if (defaultName) {
      mappings.push({
        localName: defaultName,
        exportedName: 'default',
        source: source!,
        isDefault: true,
        isNamespace: false,
      });
    }

    if (destructured) {
      const names = destructured.split(',').map((s) => s.trim());
      for (const name of names) {
        const aliasMatch = name.match(/(\w+)\s*:\s*(\w+)/);
        if (aliasMatch) {
          mappings.push({
            localName: aliasMatch[2]!,
            exportedName: aliasMatch[1]!,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        } else if (name) {
          mappings.push({
            localName: name,
            exportedName: name,
            source: source!,
            isDefault: false,
            isNamespace: false,
          });
        }
      }
    }
  }

  return mappings;
}

/**
 * Extract Python import mappings
 */
function extractPythonImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // from X import Y
  const fromImportRegex = /from\s+([\w.]+)\s+import\s+([^#\n]+)/g;
  let match;

  while ((match = fromImportRegex.exec(content)) !== null) {
    const [, source, imports] = match;
    const names = imports!.split(',').map((s) => s.trim());

    for (const name of names) {
      const aliasMatch = name.match(/(\w+)\s+as\s+(\w+)/);
      if (aliasMatch) {
        mappings.push({
          localName: aliasMatch[2]!,
          exportedName: aliasMatch[1]!,
          source: source!,
          isDefault: false,
          isNamespace: false,
        });
      } else if (name && name !== '*') {
        mappings.push({
          localName: name,
          exportedName: name,
          source: source!,
          isDefault: false,
          isNamespace: false,
        });
      }
    }
  }

  // import X
  const importRegex = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
  while ((match = importRegex.exec(content)) !== null) {
    const [, source, alias] = match;
    const localName = alias || source!.split('.').pop()!;
    mappings.push({
      localName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  return mappings;
}

/**
 * Extract Go import mappings
 */
function extractGoImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // import "path" or import alias "path"
  const singleImportRegex = /import\s+(?:(\w+)\s+)?["']([^"']+)["']/g;
  let match;

  while ((match = singleImportRegex.exec(content)) !== null) {
    const [, alias, source] = match;
    const packageName = source!.split('/').pop()!;
    mappings.push({
      localName: alias || packageName,
      exportedName: '*',
      source: source!,
      isDefault: false,
      isNamespace: true,
    });
  }

  // import ( ... ) block
  const blockImportRegex = /import\s*\(\s*([^)]+)\s*\)/gs;
  while ((match = blockImportRegex.exec(content)) !== null) {
    const block = match[1]!;
    const lineRegex = /(?:(\w+)\s+)?["']([^"']+)["']/g;
    let lineMatch;

    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const [, alias, source] = lineMatch;
      const packageName = source!.split('/').pop()!;
      mappings.push({
        localName: alias || packageName,
        exportedName: '*',
        source: source!,
        isDefault: false,
        isNamespace: true,
      });
    }
  }

  return mappings;
}

/**
 * Extract PHP import mappings (use statements)
 */
function extractPHPImports(content: string): ImportMapping[] {
  const mappings: ImportMapping[] = [];

  // use Namespace\Class; or use Namespace\Class as Alias;
  const useRegex = /use\s+([\w\\]+)(?:\s+as\s+(\w+))?;/g;
  let match;

  while ((match = useRegex.exec(content)) !== null) {
    const [, fullPath, alias] = match;
    const className = fullPath!.split('\\').pop()!;
    mappings.push({
      localName: alias || className,
      exportedName: className,
      source: fullPath!,
      isDefault: false,
      isNamespace: false,
    });
  }

  return mappings;
}

/**
 * Resolve a reference using import mappings
 */
export function resolveViaImport(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Use cached import mappings (avoids re-reading and re-parsing per ref)
  const imports = context.getImportMappings(ref.filePath, ref.language);
  if (imports.length === 0 && !context.readFile(ref.filePath)) {
    return null;
  }

  // Check if the reference name matches any import
  for (const imp of imports) {
    if (imp.localName === ref.referenceName || ref.referenceName.startsWith(imp.localName + '.')) {
      // Resolve the import path
      const resolvedPath = resolveImportPath(
        imp.source,
        ref.filePath,
        ref.language,
        context
      );

      if (resolvedPath) {
        // Find the exported symbol in the resolved file
        const nodesInFile = context.getNodesInFile(resolvedPath);
        const exportedName = imp.isDefault ? 'default' : imp.exportedName;

        // Look for the symbol
        let targetNode: Node | undefined;

        if (imp.isDefault) {
          // Find default export or main class/function
          targetNode = nodesInFile.find(
            (n) => n.isExported && (n.kind === 'function' || n.kind === 'class')
          );
        } else if (imp.isNamespace) {
          // Namespace import - look for the specific member
          const memberName = ref.referenceName.replace(imp.localName + '.', '');
          targetNode = nodesInFile.find(
            (n) => n.name === memberName && n.isExported
          );
        } else {
          // Named import
          targetNode = nodesInFile.find(
            (n) => n.name === exportedName && n.isExported
          );
        }

        if (targetNode) {
          return {
            original: ref,
            targetNodeId: targetNode.id,
            confidence: 0.9,
            resolvedBy: 'import',
          };
        }
      }
    }
  }

  return null;
}
