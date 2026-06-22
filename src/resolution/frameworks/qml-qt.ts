import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

function hasQmlFiles(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => filePath.endsWith('.qml'));
}

export const qmlQtResolver: FrameworkResolver = {
  name: 'qml-qt',
  languages: ['qml'],
  detect(context: ResolutionContext): boolean {
    return hasQmlFiles(context);
  },
  claimsReference(_name: string): boolean {
    return false;
  },
  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },
};
