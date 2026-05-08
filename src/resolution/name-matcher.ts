/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution.
 */

import { Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

/**
 * Try to resolve a path-like reference (e.g., "snippets/drawer-menu.liquid")
 * by matching the filename against file nodes.
 */
export function matchByFilePath(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (!ref.referenceName.includes('/')) return null;

  // Extract the filename from the path
  const fileName = ref.referenceName.split('/').pop();
  if (!fileName) return null;

  // Search for file nodes with this name
  const candidates = context.getNodesByName(fileName);
  const fileNodes = candidates.filter(n => n.kind === 'file');

  if (fileNodes.length === 0) return null;

  // Prefer exact path match on qualified_name
  const exactMatch = fileNodes.find(n => n.qualifiedName === ref.referenceName || n.filePath === ref.referenceName);
  if (exactMatch) {
    return {
      original: ref,
      targetNodeId: exactMatch.id,
      confidence: 0.95,
      resolvedBy: 'file-path',
    };
  }

  // Fall back to suffix match (e.g., ref="snippets/foo.liquid" matches "src/snippets/foo.liquid")
  const suffixMatch = fileNodes.find(n => n.qualifiedName.endsWith(ref.referenceName) || n.filePath.endsWith(ref.referenceName));
  if (suffixMatch) {
    return {
      original: ref,
      targetNodeId: suffixMatch.id,
      confidence: 0.85,
      resolvedBy: 'file-path',
    };
  }

  // If only one file node with this name, use it with lower confidence
  if (fileNodes.length === 1) {
    return {
      original: ref,
      targetNodeId: fileNodes[0]!.id,
      confidence: 0.7,
      resolvedBy: 'file-path',
    };
  }

  return null;
}

/**
 * Try to resolve a reference by exact name match
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const candidates = context.getNodesByName(ref.referenceName);

  if (candidates.length === 0) {
    return null;
  }

  // If only one match, use it — but penalize cross-language matches
  if (candidates.length === 1) {
    const isCrossLanguage = candidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? 0.5 : 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Multiple matches - try to narrow down
  const bestMatch = findBestMatch(ref, candidates, context);
  if (bestMatch) {
    // Lower confidence when the match is from a distant/unrelated module
    const proximity = computePathProximity(ref.filePath, bestMatch.filePath);
    const confidence = proximity >= 30 ? 0.7 : 0.4;
    return {
      original: ref,
      targetNodeId: bestMatch.id,
      confidence,
      resolvedBy: 'exact-match',
    };
  }

  return null;
}

/**
 * Try to resolve by qualified name
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Check if the reference name looks qualified (contains :: or .)
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  const candidates = context.getNodesByQualifiedName(ref.referenceName);

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.95,
      resolvedBy: 'qualified-name',
    };
  }

  // Try partial qualified name match
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts[parts.length - 1];
  if (lastName) {
    const partialCandidates = context.getNodesByName(lastName);
    for (const candidate of partialCandidates) {
      if (candidate.qualifiedName.endsWith(ref.referenceName)) {
        return {
          original: ref,
          targetNodeId: candidate.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  return null;
}

/**
 * Try to resolve by method name on a class/object
 */
export function matchMethodCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Parse method call patterns like "obj.method" or "Class::method"
  const dotMatch = ref.referenceName.match(/^(\w+)\.(\w+)$/);
  const colonMatch = ref.referenceName.match(/^(\w+)::(\w+)$/);

  const match = dotMatch || colonMatch;
  if (!match) {
    return null;
  }

  const [, objectOrClass, methodName] = match;

  // Strategy 1: Direct class name match (existing logic)
  const classCandidates = context.getNodesByName(objectOrClass!);

  for (const classNode of classCandidates) {
    if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
      // Skip cross-language class matches
      if (classNode.language !== ref.language) continue;

      const nodesInFile = context.getNodesInFile(classNode.filePath);
      const methodNode = nodesInFile.find(
        (n) =>
          n.kind === 'method' &&
          n.name === methodName &&
          n.qualifiedName.includes(classNode.name)
      );

      if (methodNode) {
        return {
          original: ref,
          targetNodeId: methodNode.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  // Strategy 2: Instance variable receiver - try capitalized form to find class
  // e.g., "permissionEngine" → look for classes containing "PermissionEngine"
  const capitalizedReceiver = objectOrClass!.charAt(0).toUpperCase() + objectOrClass!.slice(1);
  if (capitalizedReceiver !== objectOrClass) {
    const fuzzyClassCandidates = context.getNodesByName(capitalizedReceiver);
    for (const classNode of fuzzyClassCandidates) {
      if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
        // Skip cross-language class matches
        if (classNode.language !== ref.language) continue;

        const nodesInFile = context.getNodesInFile(classNode.filePath);
        const methodNode = nodesInFile.find(
          (n) =>
            n.kind === 'method' &&
            n.name === methodName &&
            n.qualifiedName.includes(classNode.name)
        );

        if (methodNode) {
          return {
            original: ref,
            targetNodeId: methodNode.id,
            confidence: 0.8,
            resolvedBy: 'instance-method',
          };
        }
      }
    }
  }

  // Strategy 3: Find methods by name across the codebase, match by receiver
  // name similarity with the containing class. Handles abbreviated variable
  // names like permissionEngine → PermissionRuleEngine.
  if (methodName) {
    const methodCandidates = context.getNodesByName(methodName!);
    const methods = methodCandidates.filter(
      (n) => n.kind === 'method' && n.name === methodName
    );

    // Filter to same-language candidates first
    const sameLanguageMethods = methods.filter(m => m.language === ref.language);
    const targetMethods = sameLanguageMethods.length > 0 ? sameLanguageMethods : methods;

    // If only one same-language method with this name exists, use it
    if (targetMethods.length === 1 && targetMethods[0]!.language === ref.language) {
      return {
        original: ref,
        targetNodeId: targetMethods[0]!.id,
        confidence: 0.7,
        resolvedBy: 'instance-method',
      };
    }

    // Multiple methods: score by receiver name word overlap with class name
    if (targetMethods.length > 1) {
      const receiverWords = splitCamelCase(objectOrClass!);
      let bestMatch: typeof targetMethods[0] | undefined;
      let bestScore = 0;

      for (const method of targetMethods) {
        const classWords = splitCamelCase(method.qualifiedName);
        let score = receiverWords.filter(w =>
          classWords.some(cw => cw.toLowerCase() === w.toLowerCase())
        ).length;
        // Bonus for same language
        if (method.language === ref.language) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = method;
        }
      }

      if (bestMatch && bestScore >= 2) {
        return {
          original: ref,
          targetNodeId: bestMatch.id,
          confidence: 0.65,
          resolvedBy: 'instance-method',
        };
      }
    }
  }

  return null;
}

/**
 * Split a camelCase or PascalCase string into words.
 */
function splitCamelCase(str: string): string[] {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:\/\\]+/)
    .filter(w => w.length > 1);
}

/**
 * Compute directory proximity between two file paths.
 * Returns a score based on the number of shared directory segments.
 * Higher score = closer in directory tree.
 */
function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/').slice(0, -1);
  const dir2 = filePath2.split('/').slice(0, -1);

  let shared = 0;
  for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
    if (dir1[i] === dir2[i]) {
      shared++;
    } else {
      break;
    }
  }

  // Each shared directory segment contributes 15 points, capped at 80
  return Math.min(shared * 15, 80);
}

/**
 * Find the best matching node when there are multiple candidates
 */
function findBestMatch(
  ref: UnresolvedRef,
  candidates: Node[],
  _context: ResolutionContext
): Node | null {
  // Prioritization rules:
  // 1. Same file > different file
  // 2. Directory proximity (same module/package > different module)
  // 3. Same language > different language
  // 4. Functions/methods > classes/types (for call references)
  // 5. Exported > non-exported

  let bestScore = -1;
  let bestNode: Node | null = null;

  for (const candidate of candidates) {
    let score = 0;

    // Same file bonus
    if (candidate.filePath === ref.filePath) {
      score += 100;
    }

    // Directory proximity bonus — strongly prefer same module/package
    score += computePathProximity(ref.filePath, candidate.filePath);

    // Language matching: strongly prefer same language, penalize cross-language
    if (candidate.language === ref.language) {
      score += 50;
    } else {
      score -= 80;
    }

    // For call references, prefer functions/methods
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      }
    }

    // For instantiation references (`new Foo()`), prefer class-like
    // targets — without this, a function named `Foo` in another module
    // could outscore the actual class.
    if (ref.referenceKind === 'instantiates') {
      if (
        candidate.kind === 'class' ||
        candidate.kind === 'struct' ||
        candidate.kind === 'interface'
      ) {
        score += 25;
      }
    }

    // For decorator references (`@Foo`), prefer functions. Class
    // decorators (Python `@SomeClass`, Java annotation interfaces)
    // also resolve here, hence the smaller class bonus.
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15;
      }
    }

    // Exported bonus
    if (candidate.isExported) {
      score += 10;
    }

    // Closer line number (within same file)
    if (candidate.filePath === ref.filePath && candidate.startLine) {
      const distance = Math.abs(candidate.startLine - ref.line);
      score += Math.max(0, 20 - distance / 10);
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = candidate;
    }
  }

  return bestNode;
}

/**
 * Fuzzy match - last resort with lower confidence
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase();

  // Use pre-built lowercase index for O(1) lookup instead of scanning all nodes
  const candidates = context.getNodesByLowerName(lowerName);

  // Filter to callable kinds only (function, method, class)
  const callableKinds = new Set(['function', 'method', 'class']);
  const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind));

  // Prefer same-language matches
  const sameLanguageCandidates = callableCandidates.filter(n => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates;

  if (finalCandidates.length === 1) {
    const isCrossLanguage = finalCandidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: finalCandidates[0]!.id,
      confidence: isCrossLanguage ? 0.3 : 0.5,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}

/**
 * Match all strategies in order of confidence
 */
export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Try strategies in order of confidence
  let result: ResolvedRef | null;

  // 0. File path match (e.g., "snippets/drawer-menu.liquid" → file node)
  result = matchByFilePath(ref, context);
  if (result) return result;

  // 1. Qualified name match (highest confidence)
  result = matchByQualifiedName(ref, context);
  if (result) return result;

  // 2. Method call pattern
  result = matchMethodCall(ref, context);
  if (result) return result;

  // 3. Exact name match
  result = matchByExactName(ref, context);
  if (result) return result;

  // 4. Fuzzy match (lowest confidence)
  result = matchFuzzy(ref, context);
  if (result) return result;

  return null;
}
