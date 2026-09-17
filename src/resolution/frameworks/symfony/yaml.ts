import { Node } from '../../../types';
import { UnresolvedRef } from '../../types';

export function extractYamlRoutes(
  filePath: string,
  content: string,
  now: number
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  // Skip YAML files without route- or service-specific keywords
  if (!/^[\t ]*(?:controller|resource|services):/m.test(content)) return { nodes, references };

  const lines = content.split('\n');
  let currentRoute: { name: string; lineNum: number } | null = null;
  let currentPathVal: string | null = null;
  let currentController: string | null = null;
  let currentMethods: string[] = [];
  let currentPrefix: string | null = null;

  const flushRoute = () => {
    if (!currentRoute || !currentPathVal) return;
    const effectivePath = currentPrefix ? currentPrefix + currentPathVal : currentPathVal;
    const httpMethods = currentMethods.length > 0 ? currentMethods : ['ANY'];
    for (const httpMethod of httpMethods) {
      nodes.push({
        id: `route:${filePath}:${currentRoute.lineNum}:${httpMethod}:${effectivePath}`,
        kind: 'route',
        name: `${httpMethod} ${effectivePath}`,
        qualifiedName: `${filePath}::${currentRoute.name}`,
        filePath,
        startLine: currentRoute.lineNum,
        endLine: currentRoute.lineNum,
        startColumn: 0,
        endColumn: 0,
        language: 'yaml',
        updatedAt: now,
      });
      if (currentController) {
        references.push({
          fromNodeId: `route:${filePath}:${currentRoute.lineNum}:${httpMethod}:${effectivePath}`,
          referenceName: currentController,
          referenceKind: 'references',
          line: currentRoute.lineNum,
          column: 0,
          filePath,
          language: 'yaml',
        });
      }
    }
  };

  let inServicesBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const keyValMatch = trimmed.match(/^([\w\-_.\\]+):\s*(.*)/);
    if (!keyValMatch) continue;

    const key = keyValMatch[1]!;
    const val = keyValMatch[2]!.trim();

    // Top-level key (column 0)
    if (indent === 0) {
      flushRoute();
      currentRoute = null;
      currentPathVal = null;
      currentController = null;
      currentMethods = [];
      currentPrefix = null;
      inServicesBlock = key === 'services';

      if (!val || val.startsWith('#')) {
        currentRoute = { name: key, lineNum: i + 1 };
      } else if (!inServicesBlock && key !== 'services') {
        currentRoute = { name: key, lineNum: i + 1 };
        currentPathVal = val.replace(/^['"]|['"]$/g, '');
      }
      continue;
    }

    // Sub-key of current route
    if (currentRoute && !inServicesBlock) {
      if (key === 'path') {
        const subVal = val.replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '');
        if (subVal) currentPathVal = subVal;
      } else if (key === 'controller') {
        const subVal = val.replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '');
        if (subVal) currentController = subVal;
      } else if (key === 'methods') {
        const m = val.match(/\[([^\]]*)\]/);
        if (m) {
          currentMethods = m[1]!.split(',').map(s => s.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean);
        }
      } else if (key === 'prefix') {
        const subVal = val.replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '');
        if (subVal) currentPrefix = subVal;
      }
    }

    // Service definitions under `services:`
    if (inServicesBlock && indent > 0) {
      const svcMatch = trimmed.match(/^([\w\\_.]+):\s*/);
      if (svcMatch && svcMatch[1]!.includes('\\') && indent >= 2) {
        references.push({
          fromNodeId: `file:${filePath}`,
          referenceName: svcMatch[1]!,
          referenceKind: 'references',
          line: i + 1,
          column: 0,
          filePath,
          language: 'yaml',
        });
      }
    }
  }
  flushRoute();

  return { nodes, references };
}
