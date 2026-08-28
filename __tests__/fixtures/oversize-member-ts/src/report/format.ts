import type { ReportRow } from './types';

/** Format one category total as a report row. */
export function formatReportRow(category: string, amountCents: number, currency: string): ReportRow {
  return {
    category,
    amount: formatAmount(amountCents),
    currency,
  };
}

/** Render cents as a fixed-point amount. */
export function formatAmount(amountCents: number): string {
  const sign = amountCents < 0 ? '-' : '';
  const abs = Math.abs(amountCents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Render a set of rows as plain text. */
export function formatReportRows(rows: ReportRow[]): string {
  return rows.map((row) => `${row.category}\t${row.amount} ${row.currency}`).join('\n');
}
