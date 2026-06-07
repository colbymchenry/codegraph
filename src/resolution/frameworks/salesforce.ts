/**
 * Salesforce Framework Resolver
 *
 * Links Lightning Web Component / Aura JavaScript to the Apex methods they
 * invoke. LWC imports Apex via a special module scheme:
 *
 *   import getAccounts from '@salesforce/apex/AccountController.getAccounts';
 *   @wire(getAccounts) accounts;        // or getAccounts({ ... })
 *
 * The JS extractor already indexes the LWC class/methods and records the
 * import, but the `@salesforce/apex/...` specifier is external, so the import
 * binding dangles. This resolver maps that binding to the existing Apex method
 * node (qualifiedName `Class::method`), producing a cross-language edge that
 * `getCallers`/`getFileDependents` can traverse ("which LWC calls this Apex
 * method").
 *
 * Cross-language note: Apex is not in any LANGUAGE_FAMILY, so the framework
 * gate (`gateFrameworkLanguage`) never drops these calls/imports edges — see
 * src/resolution/index.ts resolveOne, Strategy 1.
 */

import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

const APEX_PREFIX = '@salesforce/apex/';

/**
 * Map a `@salesforce/apex/...` module specifier to the Apex method's
 * qualifiedName `Class::method`. Handles managed-package namespaces
 * (`ns.Class.method`) by taking the last two dotted segments — repo-local
 * Apex nodes carry no namespace in their qualifiedName.
 */
function parseApexQualifiedName(source: string): string | null {
  if (!source.startsWith(APEX_PREFIX)) return null;
  const parts = source.slice(APEX_PREFIX.length).split('.');
  if (parts.length < 2) return null;
  const method = parts[parts.length - 1];
  const className = parts[parts.length - 2];
  if (!method || !className) return null;
  return `${className}::${method}`;
}

/**
 * Resolve a Visualforce markup reference. `controller=`/`extensions=` name an
 * Apex class; `<c:comp>` names a Visualforce or LWC component. Class is tried
 * first (controller refs), then component (custom-tag refs) — names rarely
 * collide across the two.
 */
function resolveVisualforceRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind !== 'references') return null;
  const named = context.getNodesByName(ref.referenceName);
  const apexClass = named.find((n) => n.kind === 'class' && n.language === 'apex');
  const component = named.find((n) => n.kind === 'component');
  const target = apexClass ?? component;
  if (!target) return null;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.9,
    resolvedBy: 'framework',
  };
}

/**
 * Resolve an LWC template `<c-child>` reference. The extractor pascalized the
 * kebab tag (`c-acct-tile` → `AcctTile`); the child component is its `.js`
 * default-export class (Lightning convention names it after the bundle) or a
 * component node. Same-bundle proximity isn't needed — child names are unique.
 */
function resolveLwcTemplateRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind !== 'references') return null;
  const named = context.getNodesByName(ref.referenceName);
  const childClass = named.find(
    (n) => n.kind === 'class' && (n.language === 'javascript' || n.language === 'typescript') && /(^|\/)lwc\//.test(n.filePath)
  );
  const component = named.find((n) => n.kind === 'component');
  const target = childClass ?? component;
  if (!target) return null;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.9,
    resolvedBy: 'framework',
  };
}

export const salesforceResolver: FrameworkResolver = {
  name: 'salesforce',
  languages: ['javascript', 'typescript', 'visualforce', 'lwc', 'aura'],

  detect(context: ResolutionContext): boolean {
    // Salesforce DX project: Apex classes present, or an lwc/aura bundle dir.
    const files = context.getAllFiles();
    return files.some(
      (f) => f.endsWith('.cls') || f.endsWith('.page') || f.endsWith('.component') || /(^|\/)(lwc|aura)\//.test(f)
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Visualforce markup → Apex controller/extension class or custom component.
    // Resolved through the framework path so the cross-language edge survives the
    // gate (Apex is its own language family — `gateFrameworkLanguage` keeps it).
    if (ref.language === 'visualforce') {
      return resolveVisualforceRef(ref, context);
    }

    // LWC HTML template <c-child> → child LWC component.
    if (ref.language === 'lwc') {
      return resolveLwcTemplateRef(ref, context);
    }

    // Aura markup <c:child> (references) → child component. The {!c.handler}
    // `calls` refs resolve through the generic name-matcher (calls aren't gated).
    if (ref.language === 'aura') {
      if (ref.referenceKind !== 'references') return null;
      const target = context.getNodesByName(ref.referenceName).find((n) => n.kind === 'component');
      if (!target) return null;
      return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'framework' };
    }

    // LWC/Aura JS: only the import binding and its call sites link to Apex.
    if (ref.referenceKind !== 'calls' && ref.referenceKind !== 'imports') return null;

    // Find the `@salesforce/apex/...` specifier this reference binds to:
    // either the import-source ref itself, or a call/binding whose local name
    // maps to such an import in this file.
    let apexSource: string | null = null;
    if (ref.referenceName.startsWith(APEX_PREFIX)) {
      apexSource = ref.referenceName;
    } else {
      const mappings = context.getImportMappings(ref.filePath, ref.language);
      const match = mappings.find(
        (im) => im.localName === ref.referenceName && im.source.startsWith(APEX_PREFIX)
      );
      if (match) apexSource = match.source;
    }
    if (!apexSource) return null;

    const qualifiedName = parseApexQualifiedName(apexSource);
    if (!qualifiedName) return null;

    const target = context
      .getNodesByQualifiedName(qualifiedName)
      .find((n) => n.kind === 'method');
    if (!target) return null;

    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.95,
      resolvedBy: 'framework',
    };
  },
};
