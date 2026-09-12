/**
 * AOSP extension — LocalSocket-based IPC detection.
 *
 * A real AOSP/AAOS local IPC shape none of the other five AOSP tools look
 * for: `android.net.LocalSocket` (client, connects) and
 * `android.net.LocalServerSocket` (server, accepts) — Unix-domain-socket
 * IPC used instead of Binder, most often to reach a native daemon that has
 * no AIDL interface at all. Confirmed as a real, non-speculative gap by
 * grepping the `platform_packages_services_car` AAOS benchmark repo (see
 * docs/design/android-platform-analysis.md's "Not covered" section before this tool
 * existed): 1 real file, `CarBugreportManagerService.java`, using
 * `LocalSocket` as a client to connect to a named local socket
 * (`connectSocket(...)` -> `new LocalSocket()` + `.connect(...)`).
 *
 * Unlike Messenger/ContentProvider, this module intentionally makes NO
 * claim about finding a same-repo counterpart: the real example above
 * connects to a socket whose SERVER side is a native daemon outside any
 * Java/Kotlin-indexed source (a common real AOSP shape — dumpstate,
 * debuggerd, and similar system daemons listen on well-known local-socket
 * names that no AIDL/HIDL declaration or Java class documents). `found`
 * here means only "this class genuinely uses LocalSocket/LocalServerSocket
 * for IPC," not "the full round-trip pair is confirmed in this repo" — see
 * `role` in the result, which is frequently `'client'` or `'server'` alone
 * with no expectation the other side ever appears.
 *
 * Neither `LocalSocket` nor `LocalServerSocket` is ever subclassed in real
 * AOSP code (both are used compositionally, like `Messenger`), so — same
 * reasoning as messenger.ts — there is no `extends`/`implements` signal to
 * reuse; this correlates `instantiates` unresolved references
 * (`new LocalSocket(...)`, `new LocalServerSocket(...)`) against a match
 * instead.
 *
 * Two structural corroboration checks apply before a hit counts as evidence
 * (Codex adversarial review, 2026-09-12, findings HIGH-1 and HIGH-2, the
 * first version of this tool had neither): class ownership via
 * `isDirectMemberOfClass` (a same-line sibling class or a nested class must
 * not falsely inherit a construction that belongs to a different class,
 * the first version's same-file + overlapping-line-range check could not
 * tell either apart), and package identity via
 * `candidateReachesPackagedSymbol` against `android.net` (a class
 * constructing some OTHER `LocalSocket` from an unrelated package, e.g.
 * `import unrelated.LocalSocket`, is not evidence of Android IPC at all;
 * a confirmed `mismatch` is dropped, `verified`/`unverifiable` both count).
 */
import type CodeGraph from '../index';
import { indexingCaveat, findClassNodeByName, isDirectMemberOfClass, candidateReachesPackagedSymbol, findResolvedReferencesToType } from './common';
import type { AospCandidate } from './aidl';

export type FindLocalSocketIpcStatus = 'found' | 'convention_derived_candidate' | 'no_local_socket_ipc_found';
export type LocalSocketIpcRole = 'client' | 'server' | 'both' | 'unknown';

export interface FindLocalSocketIpcResult {
  className: string;
  matchedClass: AospCandidate | null;
  role: LocalSocketIpcRole;
  /** `new LocalSocket(...)` sites inside the matched class's own body (client role). */
  clientEvidence: AospCandidate[];
  /** `new LocalServerSocket(...)` sites inside the matched class's own body (server role). */
  serverEvidence: AospCandidate[];
  evidence: string[];
  status: FindLocalSocketIpcStatus;
}

type IndexedNode = ReturnType<CodeGraph['searchNodes']>[number]['node'];

// Java's `new LocalSocket()` records as `'instantiates'`; Kotlin's
// constructor-call syntax (`LocalSocket()`, no `new` keyword) records as
// `'calls'` instead — the same language-dependent split verified live for
// `Messenger` in messenger.ts. Neither real LocalSocket example in the AAOS
// benchmark repo is Kotlin, but this accepts both defensively rather than
// silently missing a Kotlin caller the way messenger.ts's first version did.
const LOCAL_SOCKET_INSTANTIATE_KINDS = new Set(['instantiates', 'calls']);

// A project that indexes real (or stub) android.net.LocalSocket/
// LocalServerSocket source of its own resolves every reference successfully,
// so none of them ever reach unresolved_refs; findResolvedReferencesToType
// below reads the same evidence from the resolved graph instead, so
// indexing more of the SDK never silently deletes this tool's only evidence
// path.
function instantiatesInBody(cg: CodeGraph, node: IndexedNode | undefined, qualifiedName: 'LocalSocket' | 'LocalServerSocket'): AospCandidate[] {
  if (!node) return [];
  const candidates: AospCandidate[] = [];
  for (const ref of cg.getUnresolvedReferencesByQualifiedName(qualifiedName)) {
    if (!LOCAL_SOCKET_INSTANTIATE_KINDS.has(ref.referenceKind)) continue;
    const fromNode = cg.getNode(ref.fromNodeId);
    if (!fromNode || !isDirectMemberOfClass(fromNode.qualifiedName, node.qualifiedName)) continue;
    const packageVerified = candidateReachesPackagedSymbol(cg, fromNode.filePath, 'android.net', qualifiedName);
    if (packageVerified === 'mismatch') continue;
    candidates.push({
      kind: 'ipc_pattern_match',
      nodeKind: 'line',
      name: node.name,
      qualifiedName: node.filePath,
      filePath: ref.filePath ?? node.filePath,
      line: ref.line,
      matchedPattern: `new ${qualifiedName}(...)`,
      packageVerified,
    });
  }
  for (const { fromNode, edgeKind } of findResolvedReferencesToType(cg, 'android.net', qualifiedName, ['instantiates', 'calls'])) {
    if (!isDirectMemberOfClass(fromNode.qualifiedName, node.qualifiedName)) continue;
    candidates.push({
      kind: 'ipc_pattern_match',
      nodeKind: 'line',
      name: node.name,
      qualifiedName: node.filePath,
      filePath: fromNode.filePath,
      line: fromNode.startLine,
      matchedPattern: `new ${qualifiedName}(...) (resolved android.net.${qualifiedName}, edge: ${edgeKind})`,
      packageVerified: 'verified',
    });
  }
  return candidates;
}

export function findLocalSocketIpc(cg: CodeGraph, repoRoot: string, className: string): FindLocalSocketIpcResult {
  void repoRoot; // kept for signature parity with the other five AOSP tools; no filesystem walk needed here
  const evidence: string[] = [];
  const caveat = indexingCaveat(cg);
  if (caveat) evidence.push(caveat);

  const match = findClassNodeByName(cg, className);
  const matchedClass: AospCandidate | null = match
    ? {
        kind: 'impl_by_name',
        nodeKind: match.node.kind,
        name: match.node.name,
        qualifiedName: match.node.qualifiedName,
        filePath: match.node.filePath,
        line: match.node.startLine,
        matchedPattern: `exact class match: ${className}`,
      }
    : null;
  evidence.push(
    `class search (${match?.caseInsensitive ? 'case-insensitive index fallback' : 'exact match'}): ${className} ` +
      `(${matchedClass ? 1 : 0} hit(s))`
  );

  const clientEvidence = instantiatesInBody(cg, match?.node, 'LocalSocket');
  evidence.push(`LocalSocket construction search (package-verified new LocalSocket(...) owned directly by the matched class's own body, client role): ${clientEvidence.length} hit(s)`);

  const serverEvidence = instantiatesInBody(cg, match?.node, 'LocalServerSocket');
  evidence.push(`LocalServerSocket construction search (package-verified new LocalServerSocket(...) owned directly by the matched class's own body, server role): ${serverEvidence.length} hit(s)`);

  const role: LocalSocketIpcRole =
    clientEvidence.length > 0 && serverEvidence.length > 0 ? 'both'
      : clientEvidence.length > 0 ? 'client'
      : serverEvidence.length > 0 ? 'server'
      : 'unknown';

  let status: FindLocalSocketIpcStatus;
  if (matchedClass && (clientEvidence.length > 0 || serverEvidence.length > 0)) {
    status = 'found';
    evidence.push(
      'NOTE: "found" here only confirms this class uses LocalSocket-based IPC, not that a matching ' +
        'counterpart (the other end of the socket) exists anywhere in this repo — the real AOSP shape this ' +
        'was built against connects to a native daemon outside any indexed Java/Kotlin/C++ source'
    );
  } else if (matchedClass) {
    status = 'convention_derived_candidate';
  } else {
    status = 'no_local_socket_ipc_found';
  }

  return { className, matchedClass, role, clientEvidence, serverEvidence, evidence, status };
}
