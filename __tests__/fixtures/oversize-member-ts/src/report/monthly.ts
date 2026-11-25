import { formatReportRow } from './format';
import { persistReport } from './store';
import type { Ledger, ReportOptions, ReportRow } from './types';

/**
 * Build the monthly report for one ledger.
 *
 * Every expense category is accrued in its own block so the finance team can
 * read the month end-to-end in one place; the shape is deliberately flat.
 */
export function buildMonthlyReport(ledger: Ledger, options: ReportOptions): ReportRow[] {
  const rows: ReportRow[] = [];
  const totals = new Map<string, number>();

  // 1. payroll — accrue the payroll component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'payroll');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('payroll', adjusted, options.currency));
      totals.set('payroll', adjusted);
    }
  }

  // 2. benefits — accrue the benefits component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'benefits');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('benefits', adjusted, options.currency));
      totals.set('benefits', adjusted);
    }
  }

  // 3. travel — accrue the travel component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'travel');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('travel', adjusted, options.currency));
      totals.set('travel', adjusted);
    }
  }

  // 4. equipment — accrue the equipment component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'equipment');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('equipment', adjusted, options.currency));
      totals.set('equipment', adjusted);
    }
  }

  // 5. software — accrue the software component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'software');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('software', adjusted, options.currency));
      totals.set('software', adjusted);
    }
  }

  // 6. contractors — accrue the contractors component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'contractors');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('contractors', adjusted, options.currency));
      totals.set('contractors', adjusted);
    }
  }

  // 7. marketing — accrue the marketing component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'marketing');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('marketing', adjusted, options.currency));
      totals.set('marketing', adjusted);
    }
  }

  // 8. training — accrue the training component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'training');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('training', adjusted, options.currency));
      totals.set('training', adjusted);
    }
  }

  // 9. utilities — accrue the utilities component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'utilities');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('utilities', adjusted, options.currency));
      totals.set('utilities', adjusted);
    }
  }

  // 10. rent — accrue the rent component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'rent');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('rent', adjusted, options.currency));
      totals.set('rent', adjusted);
    }
  }

  // 11. insurance — accrue the insurance component of the month.
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

  // 12. legal — accrue the legal component of the month.
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

  // 13. shipping — accrue the shipping component of the month.
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

  // 14. hosting — accrue the hosting component of the month.
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

  // 15. support — accrue the support component of the month.
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

  // 16. recruiting — accrue the recruiting component of the month.
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

  // 17. licenses — accrue the licenses component of the month.
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

  // 18. taxes — accrue the taxes component of the month.
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

  // 19. refunds — accrue the refunds component of the month.
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

  // 20. discounts — accrue the discounts component of the month.
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

  // 21. interest — accrue the interest component of the month.
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

  // 22. depreciation — accrue the depreciation component of the month.
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

  // 23. maintenance — accrue the maintenance component of the month.
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

  // 24. subscriptions — accrue the subscriptions component of the month.
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

  // 25. hardware — accrue the hardware component of the month.
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

  // 26. catering — accrue the catering component of the month.
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

  // 27. conferences — accrue the conferences component of the month.
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

  // 28. advertising — accrue the advertising component of the month.
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

  // 29. research — accrue the research component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'research');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('research', adjusted, options.currency));
      totals.set('research', adjusted);
    }
  }

  // 30. logistics — accrue the logistics component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'logistics');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('logistics', adjusted, options.currency));
      totals.set('logistics', adjusted);
    }
  }

  // 31. warranty — accrue the warranty component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'warranty');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('warranty', adjusted, options.currency));
      totals.set('warranty', adjusted);
    }
  }

  // 32. penalties — accrue the penalties component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'penalties');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('penalties', adjusted, options.currency));
      totals.set('penalties', adjusted);
    }
  }

  // 33. bonuses — accrue the bonuses component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'bonuses');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('bonuses', adjusted, options.currency));
      totals.set('bonuses', adjusted);
    }
  }

  // 34. commissions — accrue the commissions component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'commissions');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('commissions', adjusted, options.currency));
      totals.set('commissions', adjusted);
    }
  }

  // 35. relocation — accrue the relocation component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'relocation');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('relocation', adjusted, options.currency));
      totals.set('relocation', adjusted);
    }
  }

  // 36. tooling — accrue the tooling component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'tooling');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('tooling', adjusted, options.currency));
      totals.set('tooling', adjusted);
    }
  }

  // 37. audit — accrue the audit component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'audit');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('audit', adjusted, options.currency));
      totals.set('audit', adjusted);
    }
  }

  // 38. compliance — accrue the compliance component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'compliance');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('compliance', adjusted, options.currency));
      totals.set('compliance', adjusted);
    }
  }

  // 39. storage — accrue the storage component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'storage');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('storage', adjusted, options.currency));
      totals.set('storage', adjusted);
    }
  }

  // 40. bandwidth — accrue the bandwidth component of the month.
  {
    const bucket = ledger.entries.filter((entry) => entry.category === 'bandwidth');
    const gross = bucket.reduce((sum, entry) => sum + entry.amountCents, 0);
    const pending = bucket.filter((entry) => entry.pending).reduce((s, e) => s + e.amountCents, 0);
    const adjusted = options.includePending ? gross : gross - pending;
    if (adjusted !== 0 || options.includeEmptyCategories) {
      rows.push(formatReportRow('bandwidth', adjusted, options.currency));
      totals.set('bandwidth', adjusted);
    }
  }

  const grandTotal = [...totals.values()].reduce((sum, value) => sum + value, 0);
  rows.push(formatReportRow('total', grandTotal, options.currency));
  persistReport(ledger.periodId, rows);
  return rows;
}

/** Header line for a rendered monthly report. */
export function monthlyReportHeader(ledger: Ledger, options: ReportOptions): string {
  return `Monthly report ${ledger.periodId} (${options.currency})`;
}

/** Footer line for a rendered monthly report. */
export function monthlyReportFooter(rows: ReportRow[]): string {
  return `${rows.length} categories reported`;
}
