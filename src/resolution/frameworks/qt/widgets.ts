import type { FrameworkExtractionResult, ResolutionContext, ResolvedRef, UnresolvedRef } from '../../types';

export function detectQtWidgets(context: ResolutionContext): boolean {
  void context;
  return false;
}

export function claimsQtWidgetsReference(_name: string, ref?: UnresolvedRef): boolean {
  if (!ref || ref.language === 'qml') return false;
  return false;
}

export function resolveQtWidgets(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
  return null;
}

export function extractQtWidgets(_filePath: string, _content: string): FrameworkExtractionResult {
  return { nodes: [], references: [] };
}
