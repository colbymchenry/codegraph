import type { ReportRow } from './types';

const saved = new Map<string, ReportRow[]>();

/** Persist a built report for a period. */
export function persistReport(periodId: string, rows: ReportRow[]): void {
  saved.set(periodId, rows);
}

/** Read back a persisted report. */
export function loadReport(periodId: string): ReportRow[] {
  return saved.get(periodId) ?? [];
}

/** Drop a persisted report. */
export function clearReport(periodId: string): void {
  saved.delete(periodId);
}
