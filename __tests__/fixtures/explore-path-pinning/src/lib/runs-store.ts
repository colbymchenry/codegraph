/** In-memory registry of task runs, keyed by run id. */

export interface Scope {
  projectId: string;
  label: string;
}

export const runId = 'run-000';

const runs = new Map<string, { id: string; scope: Scope; status: string }>();

export function registerRun(id: string, scope: Scope): void {
  runs.set(id, { id, scope, status: 'queued' });
}

export function getRun(id: string): { id: string; scope: Scope; status: string } | null {
  return runs.get(id) ?? null;
}

export function listRuns(scope: Scope): string[] {
  return [...runs.values()]
    .filter((r) => r.scope.projectId === scope.projectId)
    .map((r) => r.id);
}

export function stopRun(id: string): boolean {
  const run = runs.get(id);
  if (!run) return false;
  run.status = 'cancelled';
  return true;
}
