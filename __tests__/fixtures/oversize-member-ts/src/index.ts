import { buildMonthlyReport } from './report/monthly';
import { buildWeeklyReport } from './report/weekly';
import { buildQuarterlyReport } from './report/quarterly';
import { formatReportRows } from './report/format';
import type { Ledger, ReportOptions } from './report/types';

/** Run every report for a ledger and render them. */
export function runReports(ledger: Ledger, options: ReportOptions): string {
  return [
    formatReportRows(buildMonthlyReport(ledger, options)),
    formatReportRows(buildWeeklyReport(ledger, options)),
    formatReportRows(buildQuarterlyReport(ledger, options)),
  ].join('\n\n');
}
