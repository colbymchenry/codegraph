/**
 * PHP @property PHPDoc Framework Resolver
 *
 * Resolves dynamic property access through PHP magic methods (__get/__call)
 * by leveraging @property PHPDoc annotations. Common patterns:
 *
 *   - Service locator (MPF Ctx): $this->ctx->user_factory->findByUid()
 *   - MOA RPC proxy: $this->ctx->moa->UserService->getUser()
 *   - DI containers with __get dispatching
 *
 * The resolver creates `references` edges from the class using @property
 * annotations to the declared type, and resolves method calls on those
 * types when possible.
 */

import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext, FrameworkExtractionResult } from '../types';

const PROPERTY_RE = /(@property(?:-read|-write)?)\s+(\\?[A-Za-z_][\w\\|]*)\s+\$(\w+)/g;
const PRIMITIVE_TYPES = new Set([
  'string', 'int', 'integer', 'float', 'double', 'bool', 'boolean',
  'array', 'null', 'void', 'mixed', 'object', 'callable', 'iterable',
  'self', 'static', 'parent', 'never', 'true', 'false', 'resource',
]);

/**
 * Parse @property annotations from a PHPDoc block.
 * Returns tuples of [typeName, propertyName].
 */
function parsePropertyAnnotations(docblock: string): Array<{ type: string; prop: string; annotation: string }> {
  const results: Array<{ type: string; prop: string; annotation: string }> = [];
  PROPERTY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROPERTY_RE.exec(docblock))) {
    const annotation = m[1]!;
    const rawType = m[2]!;
    const simpleName = rawType.split('|')[0]!.split('\\').pop()!;
    if (simpleName && !PRIMITIVE_TYPES.has(simpleName.toLowerCase())) {
      results.push({ type: simpleName, prop: m[3]!, annotation });
    }
  }
  return results;
}

/**
 * Extract the PHPDoc block immediately preceding a class/interface declaration.
 */
function extractPrecedingDocblock(content: string, classStartLine: number): string {
  const lines = content.split('\n');
  let docblock = '';
  for (let i = classStartLine - 2; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === '' && docblock === '') continue;
    if (line.startsWith('*') || line.startsWith('/**') || line === '*/') {
      docblock = lines[i]! + '\n' + docblock;
      if (line.startsWith('/**')) break;
    } else {
      break;
    }
  }
  return docblock;
}

export const phpPhpdocResolver: FrameworkResolver = {
  name: 'php-phpdoc',
  languages: ['php'],

  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      if (!file.endsWith('.php')) continue;
      const content = context.readFile(file);
      if (content && content.includes('@property')) return true;
    }
    return false;
  },

  claimsReference(name: string): boolean {
    return name.startsWith('phpdoc-property:');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (!ref.referenceName.startsWith('phpdoc-property:')) return null;

    const typeName = ref.referenceName.slice('phpdoc-property:'.length);
    const candidates = context.getNodesByName(typeName).filter(
      (n) => (n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait') && n.language === 'php',
    );

    if (candidates.length === 0) return null;

    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.85,
      resolvedBy: 'framework',
    };
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!filePath.endsWith('.php') || !content.includes('@property')) {
      return { nodes: [], references: [] };
    }

    const references: UnresolvedRef[] = [];
    const classRe = /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/gm;
    let classMatch: RegExpExecArray | null;

    while ((classMatch = classRe.exec(content))) {
      const classLine = content.slice(0, classMatch.index).split('\n').length;
      const docblock = extractPrecedingDocblock(content, classLine);
      if (!docblock) continue;

      const props = parsePropertyAnnotations(docblock);
      for (const { type } of props) {
        references.push({
          fromNodeId: '', // will be matched by class name during resolution
          referenceName: `phpdoc-property:${type}`,
          referenceKind: 'references',
          line: classLine,
          column: 0,
          filePath,
          language: 'php',
        });
      }
    }

    return { nodes: [], references };
  },
};
