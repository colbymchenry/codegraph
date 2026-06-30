import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../../types';
import { claimsQmlQtReference, detectQmlQt, extractQmlQt, resolveQmlQt } from './qml';
import { detectQtUiFiles, extractQtUiXml } from './ui-xml';
import { claimsQtWidgetsReference, detectQtWidgets, extractQtWidgets, resolveQtWidgets } from './widgets';

function detectQt(context: ResolutionContext): boolean {
  return detectQmlQt(context) || detectQtUiFiles(context) || detectQtWidgets(context);
}

export const qtResolver: FrameworkResolver = {
  name: 'qt',
  languages: ['qml', 'yaml', 'xml', 'cpp', 'c'],
  detect: detectQt,
  claimsReference(name: string, ref?: UnresolvedRef): boolean {
    return claimsQmlQtReference(name, ref) || claimsQtWidgetsReference(name, ref);
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language === 'qml') return resolveQmlQt(ref, context);
    return resolveQtWidgets(ref, context);
  },
  extract(filePath: string, content: string) {
    if (/\.ui$/i.test(filePath)) return extractQtUiXml(filePath, content);
    const qmlResult = extractQmlQt(filePath, content);
    if (qmlResult.nodes.length > 0 || qmlResult.references.length > 0) return qmlResult;
    return extractQtWidgets(filePath, content);
  },
};
