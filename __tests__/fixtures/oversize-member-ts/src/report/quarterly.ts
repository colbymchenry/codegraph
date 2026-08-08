import { formatReportRow } from './format';
import { persistReport } from './store';
import type { Ledger, ReportOptions, ReportRow } from './types';

/** Build the quarterly report for one ledger. */
export function buildQuarterlyReport(ledger: Ledger, options: ReportOptions): ReportRow[] {
  const rows: ReportRow[] = [];
  const totals = new Map<string, number>();

  // 1. insurance — accrue the insurance component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'insurance');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('insurance', adjusted, options.currency));
      totals.set('insurance', adjusted);
    }
  }

  // 2. legal — accrue the legal component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'legal');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('legal', adjusted, options.currency));
      totals.set('legal', adjusted);
    }
  }

  // 3. shipping — accrue the shipping component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'shipping');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('shipping', adjusted, options.currency));
      totals.set('shipping', adjusted);
    }
  }

  // 4. hosting — accrue the hosting component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'hosting');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('hosting', adjusted, options.currency));
      totals.set('hosting', adjusted);
    }
  }

  // 5. support — accrue the support component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'support');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('support', adjusted, options.currency));
      totals.set('support', adjusted);
    }
  }

  // 6. recruiting — accrue the recruiting component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'recruiting');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('recruiting', adjusted, options.currency));
      totals.set('recruiting', adjusted);
    }
  }

  // 7. licenses — accrue the licenses component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'licenses');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('licenses', adjusted, options.currency));
      totals.set('licenses', adjusted);
    }
  }

  // 8. taxes — accrue the taxes component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'taxes');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('taxes', adjusted, options.currency));
      totals.set('taxes', adjusted);
    }
  }

  // 9. refunds — accrue the refunds component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'refunds');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('refunds', adjusted, options.currency));
      totals.set('refunds', adjusted);
    }
  }

  // 10. discounts — accrue the discounts component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'discounts');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('discounts', adjusted, options.currency));
      totals.set('discounts', adjusted);
    }
  }

  // 11. interest — accrue the interest component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'interest');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('interest', adjusted, options.currency));
      totals.set('interest', adjusted);
    }
  }

  // 12. depreciation — accrue the depreciation component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'depreciation');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('depreciation', adjusted, options.currency));
      totals.set('depreciation', adjusted);
    }
  }

  // 13. maintenance — accrue the maintenance component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'maintenance');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('maintenance', adjusted, options.currency));
      totals.set('maintenance', adjusted);
    }
  }

  // 14. subscriptions — accrue the subscriptions component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'subscriptions');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('subscriptions', adjusted, options.currency));
      totals.set('subscriptions', adjusted);
    }
  }

  // 15. hardware — accrue the hardware component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'hardware');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('hardware', adjusted, options.currency));
      totals.set('hardware', adjusted);
    }
  }

  // 16. catering — accrue the catering component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'catering');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('catering', adjusted, options.currency));
      totals.set('catering', adjusted);
    }
  }

  // 17. conferences — accrue the conferences component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'conferences');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('conferences', adjusted, options.currency));
      totals.set('conferences', adjusted);
    }
  }

  // 18. advertising — accrue the advertising component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'advertising');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('advertising', adjusted, options.currency));
      totals.set('advertising', adjusted);
    }
  }

  const grandTotal = [...totals.values()].reduce((sum, value) => sum + value, 0);
  rows.push(formatReportRow('total', grandTotal, options.currency));
  persistReport(ledger.periodId, rows);
  return rows;
}

/** Header line for a rendered quarterly report. */
export function buildQuarterlyReportHeader(ledger: Ledger, options: ReportOptions): string {
  return `quarterly report ${ledger.periodId} (${options.currency})`;
}
