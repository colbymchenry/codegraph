/**
 * AOSP extension — permission and broadcast candidate search.
 *
 * Both are intentionally thin: pure text-candidate search over
 * CodeGraph-indexed sources with no found/not-found claim beyond "these
 * patterns matched or they didn't". Unlike find_aidl_impl/find_jni_bridge/
 * analyze_system_service there is no single symbol whose existence a status
 * model could hang off of — a permission or broadcast action is just a
 * string, so this only reports what matched, never a synthesized confidence
 * tier.
 */
import { grepIndexedSources, escapeRegExp, indexingCaveat, testPathEvidence } from './common';
import type CodeGraph from '../index';

export interface TextCandidate {
  filePath: string;
  line: number;
  matchedPattern: string;
}

export interface TracePermissionResult {
  permission: string;
  xmlMatches: TextCandidate[];
  checkPoints: TextCandidate[];
  enforcement: TextCandidate[];
  evidence: string[];
}

export function tracePermission(cg: CodeGraph, repoRoot: string, permission: string): TracePermissionResult {
  const xmlMatches = grepIndexedSources(cg, repoRoot, ['xml'], new RegExp(escapeRegExp(permission)), permission);
  // `Self` alone (Context.checkSelfPermission, the standard API 23+
  // runtime-permission check) was missing from this alternation: it matched
  // checkCallingOrSelfPermission/checkCallingPermission/checkComponentPermission
  // but not the bare checkSelfPermission a real app/service overwhelmingly
  // uses.
  // `\b` after the pattern (not just after the optional prefix) so a longer
  // real method sharing this prefix, like `checkPermissionForPreflight` or
  // `checkSelfPermissionGranted`, doesn't get counted as a checkpoint just
  // because it starts with one of these names.
  const checkPermissionPattern = `check(?:CallingOrSelf|Calling|Self|Component)?Permission\\b`;
  const checkPointHits = grepIndexedSources(
    cg, repoRoot, ['kotlin', 'java'], new RegExp(`${checkPermissionPattern}.*${escapeRegExp(permission)}`), `${checkPermissionPattern}.*${permission}`
  );
  const checkPoints = checkPointHits;
  const enforcePermissionPattern = `enforce(?:CallingOrSelf|Calling|Component)?Permission\\b`;
  const enforcementHits = grepIndexedSources(
    cg, repoRoot, ['kotlin', 'java'], new RegExp(`${enforcePermissionPattern}.*${escapeRegExp(permission)}`), `${enforcePermissionPattern}.*${permission}`
  );
  const enforcement = enforcementHits;

  const caveat = indexingCaveat(cg);
  const evidence = [
    ...(caveat ? [caveat] : []),
    `permission XML search (plain text only): "${permission}" (${xmlMatches.length} hit(s)); ` +
      `this does not distinguish XML element kinds such as uses-permission, permission, permission-tree, or protected-broadcast`,
    `check-point search (kotlin/java): checkPermission.*${permission} (${checkPoints.length} hit(s))`,
    `enforcement search (kotlin/java): enforcePermission.*${permission} (${enforcement.length} hit(s))`,
    ...[xmlMatches, checkPointHits, enforcementHits]
      .map((hits) => testPathEvidence(hits))
      .filter((note): note is string => note !== null),
  ];

  return { permission, xmlMatches, checkPoints, enforcement, evidence };
}

export interface TraceBroadcastResult {
  action: string;
  senders: TextCandidate[];
  receivers: TextCandidate[];
  evidence: string[];
}

export function traceBroadcast(cg: CodeGraph, repoRoot: string, action: string): TraceBroadcastResult {
  const senderHits = grepIndexedSources(
    cg, repoRoot, ['kotlin', 'java'], new RegExp(`sendBroadcast.*${escapeRegExp(action)}`), `sendBroadcast.*${action}`
  );
  const senders = senderHits;
  // Real receivers usually branch on `intent.action` inside the method body
  // rather than naming the action on the same line as `onReceive(` — this
  // matches opengrok-aosp-mcp's original pattern for parity, and the
  // evidence line makes that scope limitation explicit rather than implying
  // a more precise search than what actually ran.
  const receiverHits = grepIndexedSources(
    cg, repoRoot, ['kotlin', 'java'], new RegExp(`onReceive.*${escapeRegExp(action)}`), `onReceive.*${action}`
  );
  const receivers = receiverHits;

  const caveat = indexingCaveat(cg);
  const evidence = [
    ...(caveat ? [caveat] : []),
    `sender search (kotlin/java): sendBroadcast.*${action} (${senders.length} hit(s))`,
    `receiver search (kotlin/java): onReceive.*${action} — same-line pattern only, does NOT catch the common ` +
      `"action checked inside the method body" shape (${receivers.length} hit(s))`,
    ...[senderHits, receiverHits]
      .map((hits) => testPathEvidence(hits))
      .filter((note): note is string => note !== null),
  ];

  return { action, senders, receivers, evidence };
}
