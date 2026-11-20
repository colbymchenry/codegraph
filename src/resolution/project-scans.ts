/**
 * What resolving a project reads from all of it, read once.
 *
 * Some lookups need an answer about the whole project: the namespace aliases
 * every C++ file might declare, the macros every header might define, the file
 * each `#include` names. Each thread keeps such an answer for the run, and each
 * resolver worker used to make its own, reading every source file: six workers,
 * six times the reading, for the same answer. They depend on the indexed files
 * alone, so the main thread reads them as it starts the pool and hands them
 * over, ahead of any reference a worker is sent. A worker with none of them
 * (the message is an optimization) reads them itself, as it always did.
 *
 * That reading is one synchronous stretch of the thread the liveness watchdog
 * watches (#1091), so it's kept short. Only a full index does it, whose parse
 * has just read every file: a sync may find them cold, at 5.7 ms a file on
 * redis against 0.3. And only up to MAX_FILES_SCANNED_ON_MAIN.
 */
import type { QueryBuilder } from '../db/queries';
import { adoptCppIncludeTargets, cppIncludeTargets } from './cpp-includers';
import { adoptCppNamespaceScans, cppNamespaceScans, cppScannedFileCount, type CppNamespaceScans } from './cpp-namespaces';
import type { ResolutionContext } from './types';

export interface ProjectScans {
  cpp?: {
    namespaces: CppNamespaceScans;
    includeTargets: Map<string, string | null>;
    /** The paths the includes probed that aren't indexed, and whether each is on disk. */
    probes: Map<string, boolean>;
  };
}

/**
 * Past this many C and C++ files the workers read for themselves. A file just
 * read takes up to 1.1 ms here: rocksdb's 1,413 took 0.6 to 1.1 ms each, the
 * includes included, on a busy machine. So this is 3 s at worst, and a project
 * past it pays only what every worker's own reading always cost, off this thread.
 */
export const MAX_FILES_SCANNED_ON_MAIN = 2500;

export function readProjectScans(
  context: ResolutionContext,
  queries: QueryBuilder,
  fileProbes: Map<string, boolean>,
  maxFiles: number = MAX_FILES_SCANNED_ON_MAIN
): ProjectScans {
  if (!queries.hasFilesOfLanguage('c') && !queries.hasFilesOfLanguage('cpp')) return {};
  if (cppScannedFileCount(context) > maxFiles) return {};
  return {
    cpp: {
      namespaces: cppNamespaceScans(context),
      includeTargets: cppIncludeTargets(context),
      probes: fileProbes,
    },
  };
}

export function adoptProjectScans(context: ResolutionContext, scans: ProjectScans, fileProbes: Map<string, boolean>): void {
  if (!scans.cpp) return;
  adoptCppNamespaceScans(context, scans.cpp.namespaces);
  adoptCppIncludeTargets(context, scans.cpp.includeTargets);
  for (const [file, exists] of scans.cpp.probes) fileProbes.set(file, exists);
}
