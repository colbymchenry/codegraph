/**
 * AOSP extension — Messenger-based IPC detection.
 *
 * A real, common AOSP/AAOS cross-process IPC shape that the other five AOSP
 * tools do not look for at all: instead of an AIDL `Stub` subclass, a
 * provider class wraps a `Handler` in `new Messenger(handler)` and exposes
 * it (typically from `onBind()`), while a client/manager class holds a
 * `Messenger` reference and calls `.send(Message)` on it. Confirmed as a
 * real, non-speculative gap by grepping the `platform_packages_services_car`
 * AAOS benchmark repo (see docs/design/android-platform-analysis.md's "Not covered"
 * section before this tool existed): 9 real production files (excluding
 * test/fake doubles), including `AppCardService.kt`/`AppCardServiceManager.kt`,
 * `CarProjectionService.java`/`CarProjectionManager.java`, and
 * `AoapService.java`/`AoapServiceManager.java`.
 *
 * Messenger is a `final` Android SDK class — no real AOSP code subclasses
 * it, so there is no `extends`/`implements` signal to reuse the way
 * aidl.ts's `findUnresolvedExtendsCandidates` does for AIDL. CodeGraph does
 * still record an unresolved reference for every mention of `Messenger`
 * (since it has no source in this repo), but the `referenceKind` it lands
 * under is language-dependent, verified live against the two real examples
 * this was built against: Java's `new Messenger(...)` records
 * `'instantiates'`, but Kotlin's constructor-call syntax (`Messenger(handler)`,
 * no `new` keyword) records `'calls'` instead — and a Kotlin field with an
 * explicit type annotation (`var x: Messenger? = null`) records NEITHER
 * (verified against `AppCardServiceManager.kt`, which produced zero
 * `'references'` hits despite the annotation; this is a genuine, disclosed
 * gap: a Kotlin nullable-field-only declaration with no constructor call
 * anywhere in the same class is invisible to this tool). This module
 * therefore accepts `'instantiates'`, `'calls'`, and `'references'` as
 * equally valid "this class touches Messenger" evidence.
 *
 * Two structural corroboration checks apply before a hit counts as evidence
 * for a specific class (Codex adversarial review, 2026-09-12, findings
 * HIGH-1 and HIGH-2, the first version of this tool had neither):
 *
 * 1. **Class ownership** (`isDirectMemberOfClass`): a repo-wide unresolved
 *    reference to `Messenger` says nothing about which class it belongs to
 *    on its own. The first version scoped this by `ref.line` falling
 *    inside `[classNode.startLine, classNode.endLine]`, which a sibling
 *    class sharing a source line (`class A {} class B { Messenger m; }`)
 *    or a nested class (`class Outer { static class Inner { Messenger m;
 *    } }`) both satisfy without the reference belonging to the queried
 *    class at all. Both are real false positives found live. Ownership is now
 *    checked via the reference's own qualifiedName (see
 *    `isDirectMemberOfClass` in common.ts), which distinguishes both cases
 *    correctly.
 * 2. **Package identity** (`candidateReachesPackagedSymbol`): a class that
 *    imports and constructs some OTHER `Messenger` (`import
 *    unrelated.Messenger`) is not evidence of Android IPC at all. Every hit
 *    is checked against `android.os` the same way aidl.ts checks an AIDL
 *    interface's declared package; a confirmed `mismatch` is dropped
 *    entirely, `verified`/`unverifiable` both count (an app class
 *    genuinely using `android.os.Messenger` overwhelmingly imports it
 *    explicitly, so `unverifiable` here is rare but not impossible, e.g. a
 *    same-package Android framework-internal file).
 *
 * `found` requires the provider-side class (the `{Name}Service`/`{Name}`
 * candidate) to both exist AND touch `Messenger` (package-verified, in its
 * own body) somewhere. When more than one naming-convention candidate
 * exists, the first one with real corroborating evidence wins, not simply
 * the first one found by name, so a decoy class matching the convention
 * first no longer hides a genuinely corroborated second candidate (Codex
 * adversarial review, 2026-09-12, MEDIUM-6).
 */
import type CodeGraph from '../index';
import {
  indexingCaveat,
  titleCase,
  appendSuffixWithoutDuplication,
  findClassNodeByName,
  isDirectMemberOfClass,
  candidateReachesPackagedSymbol,
  findResolvedReferencesToType,
} from './common';
import type { AospCandidate } from './aidl';

export type FindMessengerIpcStatus = 'found' | 'convention_derived_candidate' | 'no_messenger_ipc_found';

export interface FindMessengerIpcResult {
  name: string;
  providerClassName: string;
  clientClassName: string;
  providerClass: AospCandidate | null;
  clientClass: AospCandidate | null;
  /** Package-verified Messenger reference (construction or field type) directly inside the matched provider class's own body. */
  providerEvidence: AospCandidate[];
  /** Package-verified Messenger reference directly inside the matched client class's own body. */
  clientEvidence: AospCandidate[];
  evidence: string[];
  status: FindMessengerIpcStatus;
}

type IndexedNode = ReturnType<CodeGraph['searchNodes']>[number]['node'];

function toClassCandidate(node: IndexedNode | undefined, matchedPattern: string): AospCandidate | null {
  return node
    ? {
        kind: 'impl_by_name',
        nodeKind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName,
        filePath: node.filePath,
        line: node.startLine,
        matchedPattern,
      }
    : null;
}

const MESSENGER_EVIDENCE_KINDS = new Set(['instantiates', 'calls', 'references']);
const MESSENGER_KIND_LABEL: Record<string, string> = {
  instantiates: 'new Messenger(...)',
  calls: 'Messenger(...) constructor call (Kotlin, no "new" keyword)',
  references: 'Messenger-typed field/variable reference',
};

/**
 * Unresolved references to `Messenger` that (a) belong directly to `node`'s
 * own class body (not a sibling or nested class, see module docstring) and
 * (b) can actually reach `android.os.Messenger` from their file (not a
 * same-named type from an unrelated package). Both checks are real
 * corroboration; neither alone was sufficient (Codex adversarial review,
 * 2026-09-12, HIGH-1/HIGH-2).
 *
 * Also checks the RESOLVED graph via `findResolvedReferencesToType`: a
 * project that indexes real (or stub) `android.os.Messenger` source of its
 * own resolves every reference to it successfully, so none of them ever
 * reach `unresolved_refs`, and this tool previously lost its only evidence
 * path for an otherwise genuinely correct target. A resolved edge needs no separate
 * package check; pointing at the real node already proves package identity.
 */
function messengerReferencesInBody(cg: CodeGraph, node: IndexedNode | undefined): AospCandidate[] {
  if (!node) return [];
  const candidates: AospCandidate[] = [];
  for (const ref of cg.getUnresolvedReferencesByQualifiedName('Messenger')) {
    if (!MESSENGER_EVIDENCE_KINDS.has(ref.referenceKind)) continue;
    const fromNode = cg.getNode(ref.fromNodeId);
    if (!fromNode || !isDirectMemberOfClass(fromNode.qualifiedName, node.qualifiedName)) continue;
    const packageVerified = candidateReachesPackagedSymbol(cg, fromNode.filePath, 'android.os', 'Messenger');
    if (packageVerified === 'mismatch') continue;
    candidates.push({
      kind: 'ipc_pattern_match',
      nodeKind: 'line',
      name: node.name,
      qualifiedName: node.filePath,
      filePath: ref.filePath ?? node.filePath,
      line: ref.line,
      matchedPattern: MESSENGER_KIND_LABEL[ref.referenceKind] ?? `Messenger reference (${ref.referenceKind})`,
      packageVerified,
    });
  }
  for (const { fromNode, edgeKind } of findResolvedReferencesToType(cg, 'android.os', 'Messenger', ['instantiates', 'calls', 'references'])) {
    if (!isDirectMemberOfClass(fromNode.qualifiedName, node.qualifiedName)) continue;
    candidates.push({
      kind: 'ipc_pattern_match',
      nodeKind: 'line',
      name: node.name,
      qualifiedName: node.filePath,
      filePath: fromNode.filePath,
      line: fromNode.startLine,
      matchedPattern: `${MESSENGER_KIND_LABEL[edgeKind] ?? edgeKind} (resolved android.os.Messenger)`,
      packageVerified: 'verified',
    });
  }
  return candidates;
}

interface ClassCandidateEvaluation {
  className: string;
  node: IndexedNode | undefined;
  evidence: AospCandidate[];
}

/**
 * Try every naming-convention candidate in order, but don't stop at the
 * first NAME match the way the first version of this tool did; evaluate
 * every candidate's structural Messenger evidence and prefer the first one
 * that actually has any, falling back to the first name match only when
 * none of the candidates have real evidence. Fixes a real false negative:
 * a decoy `{Name}Service` class with no Messenger evidence previously won
 * outright and the tool never even looked at `{Name}` (Codex adversarial
 * review, 2026-09-12, MEDIUM-6).
 */
function evaluateClassCandidates(cg: CodeGraph, candidateNames: string[]): ClassCandidateEvaluation {
  const evaluations: ClassCandidateEvaluation[] = [];
  for (const candidateName of candidateNames) {
    const match = findClassNodeByName(cg, candidateName);
    if (!match) continue;
    evaluations.push({ className: match.node.name, node: match.node, evidence: messengerReferencesInBody(cg, match.node) });
  }
  const corroborated = evaluations.find((e) => e.evidence.length > 0);
  if (corroborated) return corroborated;
  if (evaluations.length > 0) return evaluations[0]!;
  return { className: candidateNames[0]!, node: undefined, evidence: [] };
}

export function findMessengerIpc(cg: CodeGraph, repoRoot: string, name: string): FindMessengerIpcResult {
  void repoRoot; // kept for signature parity with the other five AOSP tools; no filesystem walk needed here
  const evidence: string[] = [];
  const caveat = indexingCaveat(cg);
  if (caveat) evidence.push(caveat);

  const baseName = titleCase(name);
  const providerCandidateNames = Array.from(
    new Set([appendSuffixWithoutDuplication(baseName, 'Service'), baseName])
  );
  const providerEval = evaluateClassCandidates(cg, providerCandidateNames);
  const providerClassName = providerEval.className;
  const providerNode = providerEval.node;
  const providerClass = toClassCandidate(providerNode, `exact class match: ${providerClassName}`);
  evidence.push(
    `provider class search (tried ${providerCandidateNames.join(', ')}, preferring a candidate with real Messenger ` +
      `evidence over the first name match): ${providerClassName} (${providerClass ? 1 : 0} hit(s))`
  );

  const clientCandidateNames = Array.from(
    new Set([
      appendSuffixWithoutDuplication(providerClassName, 'Manager'),
      appendSuffixWithoutDuplication(baseName, 'Manager'),
    ])
  );
  const clientEval = evaluateClassCandidates(cg, clientCandidateNames);
  const clientClassName = clientEval.className;
  const clientNode = clientEval.node;
  const clientClass = toClassCandidate(clientNode, `exact class match: ${clientClassName}`);
  evidence.push(
    `client class search (tried ${clientCandidateNames.join(', ')}): ${clientClassName} (${clientClass ? 1 : 0} hit(s))`
  );

  const providerEvidence = providerEval.evidence;
  evidence.push(
    `Messenger reference search (package-verified construction or field-type reference to android.os.Messenger, ` +
      `owned directly by the matched provider class's own body, the primary signal this class participates in a ` +
      `Messenger IPC channel): ${providerEvidence.length} hit(s)`
  );

  const clientEvidence = clientEval.evidence;
  evidence.push(
    `Messenger reference search (owned directly by the matched client class's own body, supplementary, never ` +
      `sufficient alone for "found"): ${clientEvidence.length} hit(s)`
  );

  let status: FindMessengerIpcStatus;
  if (providerClass && providerEvidence.length > 0) {
    status = 'found';
  } else if (providerClass || clientClass) {
    status = 'convention_derived_candidate';
  } else {
    status = 'no_messenger_ipc_found';
  }

  return { name, providerClassName, clientClassName, providerClass, clientClass, providerEvidence, clientEvidence, evidence, status };
}
