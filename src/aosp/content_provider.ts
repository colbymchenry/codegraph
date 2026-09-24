/**
 * AOSP extension: ContentProvider IPC detection.
 *
 * A real AOSP/AAOS cross-process data-sharing shape none of the other five
 * AOSP tools look for: a class extends `android.content.ContentProvider`
 * instead of an AIDL `Stub`, is declared in `AndroidManifest.xml` with one
 * or more `android:authorities`, and clients reach it through
 * `ContentResolver` rather than a Binder interface. Confirmed as a real,
 * non-speculative gap by grepping the `platform_packages_services_car` AAOS
 * benchmark repo (see docs/design/android-platform-analysis.md's "Not covered" section
 * before this tool existed): exactly 2 real files,
 * `ClusterContentProvider.java` and `BugStorageProvider.java`.
 *
 * Unlike Messenger (`final`, never subclassed) and LocalSocket (usage-only,
 * no class hierarchy), `ContentProvider` IS a real, subclassable Android SDK
 * class, so a `class Foo extends ContentProvider` clause is exactly the same
 * structural shape AIDL's `Stub` subclass is: CodeGraph records it as an
 * unresolved extends reference (no `ContentProvider` source in this repo),
 * reusing aidl.ts's `findUnresolvedExtendsCandidates` for the primary
 * signal, same discipline as find_aidl_impl's Stub-subclass check. The
 * manifest declaration and ContentResolver client usage are corroborating
 * text-candidate evidence, real but never sufficient alone.
 *
 * `findUnresolvedExtendsCandidates` matches a class purely by the BARE name
 * `ContentProvider`, which is exactly why the first version of this module
 * passed `packageName: null` (no package check at all): every hit, from any
 * package, promoted straight to `found`. That silently accepted a class
 * extending some unrelated `unrelated.ContentProvider` type as real Android
 * IPC evidence, and separately never recognized a fully-qualified
 * `extends android.content.ContentProvider` clause at all, since that
 * reference's name is the FQCN string, not the bare name. Both are fixed by
 * `findAllContentProviderCandidates` below: the bare-name lookup
 * now runs with `packageName: 'android.content'` so a `mismatch` is
 * dropped, and a second, FQCN-qualified lookup catches the fully-qualified
 * spelling directly (a real FQCN clause commits to the package textually,
 * so it is always `verified`, no import check needed).
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from '../index';
import { escapeRegExp, indexingCaveat, stripXmlComments, testPathEvidence, grepIndexedSources, resolveContainedRepoRoot, resolveContainedFilePath, findResolvedReferencesToType } from './common';
import { findUnresolvedExtendsCandidates } from './aidl';
import type { AospCandidate } from './aidl';
import type { TextCandidate } from './permission_broadcast';

export type FindContentProviderStatus = 'found' | 'convention_derived_candidate' | 'no_content_provider_found';

export interface ManifestProviderDeclaration extends TextCandidate {
  authorities: string[];
}

export interface FindContentProviderResult {
  className: string;
  providerClass: AospCandidate | null;
  manifestDeclarations: ManifestProviderDeclaration[];
  clientUsageSites: TextCandidate[];
  evidence: string[];
  status: FindContentProviderStatus;
}

const CONTENT_PROVIDER_PACKAGE = 'android.content';
const CONTENT_PROVIDER_BARE_NAME = 'ContentProvider';
const CONTENT_PROVIDER_FQCN = `${CONTENT_PROVIDER_PACKAGE}.${CONTENT_PROVIDER_BARE_NAME}`;

/**
 * Every real `extends ContentProvider` candidate in the repo, package-
 * verified against `android.content` and deduplicated across the two ways
 * a real subclass can spell it (bare name with an import, or a fully
 * qualified clause with no import at all). A `mismatch` (an unrelated
 * same-named type from a different package) is dropped entirely, never
 * just demoted, since there is exactly one real `android.content.
 * ContentProvider` (unlike AIDL, two same-named interfaces in different
 * packages cannot legitimately both be "the" ContentProvider here).
 */
function findAllContentProviderCandidates(cg: CodeGraph): { candidates: AospCandidate[]; mismatchCount: number } {
  const seen = new Set<string>();
  const candidates: AospCandidate[] = [];
  let mismatchCount = 0;

  const bareNameHits = findUnresolvedExtendsCandidates(cg, CONTENT_PROVIDER_BARE_NAME, CONTENT_PROVIDER_PACKAGE, [CONTENT_PROVIDER_FQCN]);
  for (const candidate of bareNameHits) {
    const key = `${candidate.filePath}:${candidate.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (candidate.packageVerified === 'mismatch') {
      mismatchCount++;
      continue;
    }
    candidates.push(candidate);
  }

  // A fully-qualified `extends android.content.ContentProvider` clause
  // records its unresolved reference under the FQCN string, not the bare
  // name, so the lookup above never sees it; reused verbatim so this stays
  // real structural evidence, not a naming-convention guess. The FQCN
  // itself already commits to the real package textually, so this is
  // always `verified`: there is no meaningful "does this file's imports
  // reach android.content.ContentProvider" question left to ask when the
  // extends clause already spelled the package out in full.
  for (const ref of cg.getUnresolvedReferencesByQualifiedName(CONTENT_PROVIDER_FQCN)) {
    if (ref.referenceKind !== 'extends' && ref.referenceKind !== 'implements') continue;
    const node = cg.getNode(ref.fromNodeId);
    if (!node) continue;
    const key = `${node.filePath}:${node.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      kind: ref.referenceKind === 'extends' ? 'stub_subclass' : 'impl_by_interface',
      nodeKind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      line: node.startLine,
      matchedPattern: `unresolved ${ref.referenceKind} -> ${ref.referenceName}`,
      packageVerified: 'verified',
    });
  }

  // A project that indexes real (or stub) android.content.ContentProvider
  // source of its own resolves an `extends ContentProvider` clause
  // successfully, so it never reaches unresolved_refs at all; this reads
  // the same evidence from the resolved graph instead, so indexing more of
  // the SDK never silently deletes this tool's only evidence path. Pointing at
  // the real resolved node already proves package identity, same as the
  // FQCN path above.
  for (const { fromNode, edgeKind } of findResolvedReferencesToType(cg, CONTENT_PROVIDER_PACKAGE, CONTENT_PROVIDER_BARE_NAME, ['extends', 'implements'])) {
    const key = `${fromNode.filePath}:${fromNode.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      kind: edgeKind === 'extends' ? 'stub_subclass' : 'impl_by_interface',
      nodeKind: fromNode.kind,
      name: fromNode.name,
      qualifiedName: fromNode.qualifiedName,
      filePath: fromNode.filePath,
      line: fromNode.startLine,
      matchedPattern: `resolved ${edgeKind} -> android.content.ContentProvider`,
      packageVerified: 'verified',
    });
  }

  return { candidates, mismatchCount };
}

// A `<provider ...>` OPENING element only, deliberately stops at the first
// unescaped `>` rather than walking to a matching `</provider>` the way the
// first version of this module did. That version searched the ENTIRE block
// including any child elements (`<meta-data android:name="...">`,
// `<grant-uri-permission>`, ...) for `android:name`/`android:authorities`,
// so a `<meta-data android:name="GhostProvider" .../>` nested inside a real
// `<provider android:name="RealProvider" ...>` could be mistaken for the
// provider's own name. Every
// attribute this tool needs (name, authorities) is always on the provider's
// own opening tag, never on a child, so scoping to just that tag is strictly
// more correct, not just narrower.
const PROVIDER_OPEN_TAG_RE = /<provider\b[^>]*>/g;
// AOSP manifests use both quote styles for XML attributes; the first
// version only recognized double quotes and silently missed every
// single-quoted attribute.
const NAME_ATTR_RE = /android:name\s*=\s*["']([^"']+)["']/;
const AUTHORITIES_ATTR_RE = /android:authorities\s*=\s*["']([^"']+)["']/;

/**
 * Does `nameAttrValue` (the manifest's `android:name` on a `<provider>`
 * element) refer to `className`? AOSP manifests use either the fully
 * qualified class name, or Android's package-relative shorthand (a leading
 * `.`, e.g. `.cluster.ClusterContentProvider`, resolved against the
 * manifest's own `package` attribute at runtime), this only checks the
 * bare simple name matches, not the full package, since resolving the
 * relative form correctly would require also parsing the manifest's
 * top-level `package`/`android:name` (the application ID), which real AOSP
 * app manifests here do not consistently declare inline. A false match
 * against an unrelated same-named class in a different package is possible
 * but rare enough in practice (AOSP class names are usually distinctive)
 * that this is disclosed in evidence rather than engineered away.
 */
function manifestNameMatchesClass(nameAttrValue: string, className: string): boolean {
  const simple = nameAttrValue.split('.').pop() ?? nameAttrValue;
  return simple === className;
}

function findManifestProviderDeclarations(cg: CodeGraph, repoRoot: string, className: string): { declarations: ManifestProviderDeclaration[]; testPathNote: string | null } {
  const declarations: ManifestProviderDeclaration[] = [];
  const looksLikeTestPathHits: TextCandidate[] = [];
  const containedRoot = resolveContainedRepoRoot(repoRoot);
  for (const file of cg.getFiles()) {
    if (file.language !== 'xml' || path.basename(file.path) !== 'AndroidManifest.xml') continue;
    const realFilePath = resolveContainedFilePath(containedRoot, file.path);
    if (!realFilePath) continue;
    let rawText: string;
    try {
      rawText = fs.readFileSync(realFilePath, 'utf-8');
    } catch {
      continue; // file removed/renamed since last index sync — skip, don't abort
    }
    const text = stripXmlComments(rawText);
    PROVIDER_OPEN_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PROVIDER_OPEN_TAG_RE.exec(text)) !== null) {
      const openTag = match[0];
      const nameAttr = NAME_ATTR_RE.exec(openTag)?.[1];
      if (!nameAttr || !manifestNameMatchesClass(nameAttr, className)) continue;
      const authoritiesAttr = AUTHORITIES_ATTR_RE.exec(openTag)?.[1];
      // A single android:authorities can declare several authorities
      // separated by ';' (AOSP manifest convention for a provider that
      // serves more than one authority string).
      const authorities = authoritiesAttr ? authoritiesAttr.split(';').map((a) => a.trim()).filter(Boolean) : [];
      const line = text.slice(0, match.index).split('\n').length;
      const candidate: ManifestProviderDeclaration = {
        filePath: file.path,
        line,
        matchedPattern: `<provider android:name="${nameAttr}" ...>`,
        authorities,
      };
      declarations.push(candidate);
      looksLikeTestPathHits.push(candidate);
    }
  }
  return { declarations, testPathNote: testPathEvidence(looksLikeTestPathHits) };
}

export function findContentProviderImpl(cg: CodeGraph, repoRoot: string, className: string): FindContentProviderResult {
  const evidence: string[] = [];
  const caveat = indexingCaveat(cg);
  if (caveat) evidence.push(caveat);

  const allCandidatesResult = findAllContentProviderCandidates(cg);
  const matched = allCandidatesResult.candidates.filter((c) => c.name === className);
  const providerClass = matched[0] ?? null;
  evidence.push(
    `unresolved_refs search: extends -> ContentProvider (bare name, package-verified against android.content) and ` +
      `extends -> android.content.ContentProvider (fully qualified), filtered to class "${className}" ` +
      `(${matched.length} hit(s) of ${allCandidatesResult.candidates.length} total package-verified ContentProvider ` +
      'subclass(es) in this repo, highest-confidence signal)'
  );
  if (allCandidatesResult.mismatchCount > 0) {
    evidence.push(
      `${allCandidatesResult.mismatchCount} bare-name "ContentProvider" extends candidate(s) repo-wide could not ` +
        'reach android.content from their file (no matching import, not in that package) and were dropped entirely, ' +
        'not just demoted, since an unrelated same-named type is not evidence of Android IPC'
    );
  }
  if (matched.length > 1) {
    evidence.push(
      `${matched.length} classes named "${className}" all extend ContentProvider in different files/packages, ` +
        'reporting the first one found; this tool has no per-class disambiguator beyond the simple name'
    );
  }

  const manifestResult = findManifestProviderDeclarations(cg, repoRoot, className);
  evidence.push(
    `manifest search (AndroidManifest.xml, CodeGraph-indexed files only): ` +
      `<provider android:name=...${className}> (${manifestResult.declarations.length} hit(s))`
  );
  if (manifestResult.testPathNote) evidence.push(manifestResult.testPathNote);

  const authorities = Array.from(new Set(manifestResult.declarations.flatMap((d) => d.authorities)));
  let clientUsageSites: TextCandidate[] = [];
  if (authorities.length > 0) {
    const authorityPattern = authorities.map(escapeRegExp).join('|');
    // stripComments: false: the default comment-blanking pass treats a
    // content:// URI literal's own "//" exactly like a line comment and
    // deletes everything after it, silently erasing the authority this
    // search is looking for on the ordinary single-line client shape
    // (`query(Uri.parse("content://authority/path"), ...)`). See grepIndexedSources'
    // own docstring for why this is a deliberate per-caller opt-out, not a
    // global behavior change.
    const clientHits = grepIndexedSources(
      cg,
      repoRoot,
      ['kotlin', 'java'],
      new RegExp(`ContentResolver.*(?:${authorityPattern})|(?:${authorityPattern}).*ContentResolver`),
      `ContentResolver <-> ${authorities.join(', ')}`,
      { stripComments: false }
    );
    clientUsageSites = clientHits;
    evidence.push(
      `client-usage search (same-line ContentResolver + declared authority, ${authorities.join(', ')}): ` +
        `${clientUsageSites.length} hit(s), a genuine client call spanning multiple lines (e.g. a Uri built earlier ` +
        'and passed to query()/insert() later) will not match this same-line pattern'
    );
  } else {
    evidence.push('no authority found in a manifest declaration, skipped client-usage search (nothing to match against)');
  }

  let status: FindContentProviderStatus;
  if (providerClass) {
    status = 'found';
  } else if (manifestResult.declarations.length > 0 || clientUsageSites.length > 0) {
    status = 'convention_derived_candidate';
  } else {
    status = 'no_content_provider_found';
  }

  return { className, providerClass, manifestDeclarations: manifestResult.declarations, clientUsageSites, evidence, status };
}
