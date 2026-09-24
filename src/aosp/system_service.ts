/**
 * AOSP extension — system service lifecycle analysis (startup / registration
 * / client usage), the AOSP `XxxManagerService` convention.
 *
 * Same discipline as find_aidl_impl/find_jni_bridge: naming-convention and
 * grep hits are real signal but not proof on their own. `found` requires the
 * exact `{Name}ManagerService` class AND one of two kinds of corroborating
 * evidence:
 *   - a registration hit in the SAME FILE as that class (a
 *     grep hit anywhere else in the repo — a comment, an unrelated service
 *     of a similar name — does not confirm this specific service's
 *     lifecycle); or
 *   - a startup-site hit that names the exact service class,
 *     which is corroborating on its own regardless of file, because the
 *     AOSP convention places that call in SystemServer.java/.kt — a
 *     different file from the service class by design, unlike JNI's
 *     native-declaration/RegisterNatives pair which are conventionally
 *     colocated. Applying JNI's same-file rule here produced false
 *     negatives on exactly this common shape.
 */
import type CodeGraph from '../index';
import { grepIndexedSources, escapeRegExp, indexingCaveat, testPathEvidence, titleCase, appendSuffixWithoutDuplication, findClassNodeByName } from './common';
import type { AospCandidate } from './aidl';

export type AnalyzeSystemServiceStatus = 'found' | 'convention_derived_candidate' | 'no_service_found';

export interface AnalyzeSystemServiceResult {
  serviceName: string;
  serviceClassName: string;
  serviceClass: AospCandidate | null;
  registrations: AospCandidate[];
  startupSites: AospCandidate[];
  clientUsageSites: AospCandidate[];
  evidence: string[];
  status: AnalyzeSystemServiceStatus;
}

// These are the SystemServer/SystemServiceManager entry points that start a
// service. Keeping the verb set explicit avoids treating an arbitrary method
// declaration (for example startNonAppWindowAnimations(...)) or a
// ProtoOutputStream call (proto.start(...)) as lifecycle evidence (HIGH-2).
const STARTUP_API_NAMES = [
  'startService',
  'startSystemService',
  'startCoreServices',
  'startOtherServices',
  'startBootstrapServices',
  'startEssentialServices',
] as const;
const STARTUP_API_RE = `(?:${STARTUP_API_NAMES.join('|')})`;

type IndexedClassNode = ReturnType<CodeGraph['searchNodes']>[number]['node'];

export function analyzeSystemService(cg: CodeGraph, repoRoot: string, serviceName: string): AnalyzeSystemServiceResult {
  const baseName = titleCase(serviceName);
  const serviceClassNames = Array.from(
    new Set(
      ['ManagerService', 'Service', 'Controller', 'Manager'].map((suffix) =>
        appendSuffixWithoutDuplication(baseName, suffix)
      )
    )
  );
  let serviceClassName = serviceClassNames[0]!;
  let usedCaseInsensitiveClassLookup = false;
  const evidence: string[] = [];
  const caveat = indexingCaveat(cg);
  if (caveat) evidence.push(caveat);

  let classNode: IndexedClassNode | undefined;
  for (const candidateName of serviceClassNames) {
    const match = findClassNodeByName(cg, candidateName);
    if (match) {
      serviceClassName = match.node.name;
      classNode = match.node;
      if (match.caseInsensitive) usedCaseInsensitiveClassLookup = true;
      break;
    }
  }
  const serviceClass: AospCandidate | null = classNode
    ? {
        kind: 'impl_by_name',
        nodeKind: classNode.kind,
        name: classNode.name,
        qualifiedName: classNode.qualifiedName,
        filePath: classNode.filePath,
        line: classNode.startLine,
        matchedPattern: `exact class match: ${serviceClassName}`,
      }
    : null;
  evidence.push(
    `service class search (${usedCaseInsensitiveClassLookup ? 'case-insensitive index fallback' : 'exact match'}, ` +
      `tried ${serviceClassNames.join(', ')}): ${serviceClassName} (${serviceClass ? 1 : 0} hit(s))`
  );

  const escapedServiceName = escapeRegExp(serviceName);
  const escapedServiceClassName = escapeRegExp(serviceClassName);

  // Match the first addService argument as one complete quoted literal and
  // require the ServiceManager receiver. This prevents a lookup for "power"
  // from consuming "power_save" or LocalServices.addService(...) (HIGH-3).
  const registrationPattern = `\\bServiceManager\\s*\\.\\s*addService\\s*\\(\\s*"${escapedServiceName}"(?=\\s*[,\\)])`;
  const registrationHits = grepIndexedSources(
    cg, repoRoot, ['kotlin', 'java'], new RegExp(registrationPattern), `ServiceManager.addService("${serviceName}", ...)`
  );
  evidence.push(`registration search: ${registrationPattern} (${registrationHits.length} hit(s))`);

  // `publishBinderService(Context.POWER_SERVICE, mBinderService, ...)` is the
  // modern SystemService base-class registration API, used alongside (and
  // increasingly instead of) a direct ServiceManager.addService call: real
  // AOSP verified, PowerManagerService registers this way exclusively, so
  // the addService-only search above found zero registration evidence for
  // it. The service name is almost always passed as a Context.*_SERVICE
  // constant here, not the literal string, so this search intentionally
  // does not require `serviceName` on the line (unlike the addService
  // search above).
  //
  // Because the call carries no service-name text of its own, this signal
  // is scoped to hits whose LINE actually falls inside the matched service
  // class's own body (classNode.startLine..endLine), not merely the same
  // file: a file can hold more than one class, and same-file-only
  // correlation would let a completely unrelated class's
  // publishBinderService call in the same file false-corroborate this one.
  // A repo-wide hit outside the class body still appears in evidence for visibility, but never counts toward
  // "found".
  const publishHitsRepoWide = grepIndexedSources(
    cg, repoRoot, ['kotlin', 'java'], /publishBinderService\s*\(/, 'publishBinderService(...)'
  );
  const publishHits = classNode
    ? publishHitsRepoWide.filter(
        (hit) => hit.filePath === classNode.filePath && hit.line >= classNode.startLine && hit.line <= classNode.endLine
      )
    : [];
  evidence.push(
    `registration search: publishBinderService(...) (${publishHitsRepoWide.length} hit(s) repo-wide, ` +
      `${publishHits.length} inside the matched service class's own body; only those count toward "found")`
  );

  const registrations = [...registrationHits, ...publishHits].map((hit): AospCandidate => ({
    kind: 'service_registration', nodeKind: 'line', name: serviceName,
    qualifiedName: hit.filePath, filePath: hit.filePath, line: hit.line, matchedPattern: hit.matchedPattern,
  }));

  // Scoped to an actual `start...(` CALL, not just the word "start" anywhere
  // on the line — the plain `start.*{ClassName}` pattern matched a bare
  // diagnostic string like `Log.d(TAG, "waiting for start of
  // FooManagerService before continuing")` just as readily as a real
  // `startService(FooManagerService::class.java)` call, and this signal is
  // the ONE this module accepts cross-file with no same-file corroboration
  // required — a log line alone was therefore enough to earn the highest
  // confidence tier, "found". This narrows the false-positive surface without
  // reintroducing the same-file requirement that produced false negatives
  // on the legitimate SystemServer-starts-it-elsewhere shape in the first
  // place — it does not eliminate every way a comment or string could still
  // look like a call (grepIndexedSources is still a plain text scan).
  const startupPattern = `(?:^|\\.)\\s*${STARTUP_API_RE}\\s*\\([^;\\n]*\\b${escapedServiceClassName}\\b`;
  const startupPatternLabel = `${STARTUP_API_RE}(...${serviceClassName}) (known startup API call-site pattern)`;
  const startupHits = grepIndexedSources(
    cg, repoRoot, ['kotlin', 'java'], new RegExp(startupPattern), startupPatternLabel
  );
  const startupSites = startupHits.map((hit): AospCandidate => ({
    kind: 'service_registration', nodeKind: 'line', name: serviceClassName,
    qualifiedName: hit.filePath, filePath: hit.filePath, line: hit.line, matchedPattern: hit.matchedPattern,
  }));
  evidence.push(
    `startup search (call-site pattern, e.g. startService(${serviceClassName}...)): ${startupSites.length} hit(s) ` +
      '(this text pattern may also match call-shaped text inside string literals)'
  );

  const clientUsageHits = grepIndexedSources(
    cg, repoRoot, ['kotlin', 'java'], new RegExp(`getSystemService.*${escapedServiceName}`), `getSystemService.*${serviceName}`
  );
  const clientUsageSites = clientUsageHits.map((hit): AospCandidate => ({
    kind: 'service_registration', nodeKind: 'line', name: serviceName,
    qualifiedName: hit.filePath, filePath: hit.filePath, line: hit.line, matchedPattern: hit.matchedPattern,
  }));
  evidence.push(`client-usage search: getSystemService.*${serviceName} (${clientUsageSites.length} hit(s))`);
  for (const hits of [registrationHits, publishHits, startupHits, clientUsageHits]) {
    const note = testPathEvidence(hits);
    if (note) evidence.push(note);
  }

  // A client lookup only proves that code asks for this service name; it does
  // not prove that this class registers or provides it. Keep it visible in
  // evidence, but never let it participate in same-file confirmation.
  const supportEvidence = [...registrations, ...startupSites];
  const correlated = serviceClass ? supportEvidence.filter((c) => c.filePath === serviceClass.filePath) : [];
  if (serviceClass && correlated.length > 0) {
    evidence.push(
      `${correlated.length} supporting hit(s) share a file with the service class (same-file correlation)`
    );
  }
  if (serviceClass && startupSites.length > 0) {
    evidence.push(
      `${startupSites.length} startup site(s) name the exact class "${serviceClassName}" ` +
        `(cross-file class-name reference — sufficient alone for "found", unlike the same-file-only ` +
        `registration signals which only match the bare service name)`
    );
  }

  let status: AnalyzeSystemServiceStatus;
  if (serviceClass && (correlated.length > 0 || startupSites.length > 0)) {
    status = 'found';
  } else if (serviceClass || supportEvidence.length > 0 || clientUsageSites.length > 0) {
    status = 'convention_derived_candidate';
  } else {
    status = 'no_service_found';
  }

  return { serviceName, serviceClassName, serviceClass, registrations, startupSites, clientUsageSites, evidence, status };
}
