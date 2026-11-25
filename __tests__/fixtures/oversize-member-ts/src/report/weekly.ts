import { formatReportRow } from './format';
import { persistReport } from './store';
import type { Ledger, ReportOptions, ReportRow } from './types';

/** Total the posted entries in one category. */
function sumOf(ledger: Ledger, category: string): number {
  return ledger.entries
    .filter((entry) => entry.category === category && !entry.pending)
    .reduce((sum, entry) => sum + entry.amountCents, 0);
}

/** Total the still-pending entries in one category. */
function pendingOf(ledger: Ledger, category: string): number {
  return ledger.entries
    .filter((entry) => entry.category === category && entry.pending)
    .reduce((sum, entry) => sum + entry.amountCents, 0);
}

/** Build the weekly report for one ledger. */
export function buildWeeklyReport(ledger: Ledger, options: ReportOptions): ReportRow[] {
  const rows: ReportRow[] = [];
  const totals = new Map<string, number>();

  // 1. payroll
  {
    const gross = sumOf(ledger, 'payroll');
    const held = pendingOf(ledger, 'payroll');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('payroll', net, options.currency));
      totals.set('payroll', net);
    }
  }

  // 2. benefits
  {
    const gross = sumOf(ledger, 'benefits');
    const held = pendingOf(ledger, 'benefits');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('benefits', net, options.currency));
      totals.set('benefits', net);
    }
  }

  // 3. travel
  {
    const gross = sumOf(ledger, 'travel');
    const held = pendingOf(ledger, 'travel');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('travel', net, options.currency));
      totals.set('travel', net);
    }
  }

  // 4. equipment
  {
    const gross = sumOf(ledger, 'equipment');
    const held = pendingOf(ledger, 'equipment');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('equipment', net, options.currency));
      totals.set('equipment', net);
    }
  }

  // 5. software
  {
    const gross = sumOf(ledger, 'software');
    const held = pendingOf(ledger, 'software');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('software', net, options.currency));
      totals.set('software', net);
    }
  }

  // 6. contractors
  {
    const gross = sumOf(ledger, 'contractors');
    const held = pendingOf(ledger, 'contractors');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('contractors', net, options.currency));
      totals.set('contractors', net);
    }
  }

  // 7. marketing
  {
    const gross = sumOf(ledger, 'marketing');
    const held = pendingOf(ledger, 'marketing');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('marketing', net, options.currency));
      totals.set('marketing', net);
    }
  }

  // 8. training
  {
    const gross = sumOf(ledger, 'training');
    const held = pendingOf(ledger, 'training');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('training', net, options.currency));
      totals.set('training', net);
    }
  }

  // 9. utilities
  {
    const gross = sumOf(ledger, 'utilities');
    const held = pendingOf(ledger, 'utilities');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('utilities', net, options.currency));
      totals.set('utilities', net);
    }
  }

  // 10. rent
  {
    const gross = sumOf(ledger, 'rent');
    const held = pendingOf(ledger, 'rent');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('rent', net, options.currency));
      totals.set('rent', net);
    }
  }

  // 11. insurance
  {
    const gross = sumOf(ledger, 'insurance');
    const held = pendingOf(ledger, 'insurance');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('insurance', net, options.currency));
      totals.set('insurance', net);
    }
  }

  // 12. legal
  {
    const gross = sumOf(ledger, 'legal');
    const held = pendingOf(ledger, 'legal');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('legal', net, options.currency));
      totals.set('legal', net);
    }
  }

  // 13. shipping
  {
    const gross = sumOf(ledger, 'shipping');
    const held = pendingOf(ledger, 'shipping');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('shipping', net, options.currency));
      totals.set('shipping', net);
    }
  }

  // 14. hosting
  {
    const gross = sumOf(ledger, 'hosting');
    const held = pendingOf(ledger, 'hosting');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('hosting', net, options.currency));
      totals.set('hosting', net);
    }
  }

  // 15. support
  {
    const gross = sumOf(ledger, 'support');
    const held = pendingOf(ledger, 'support');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('support', net, options.currency));
      totals.set('support', net);
    }
  }

  // 16. recruiting
  {
    const gross = sumOf(ledger, 'recruiting');
    const held = pendingOf(ledger, 'recruiting');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('recruiting', net, options.currency));
      totals.set('recruiting', net);
    }
  }

  // 17. licenses
  {
    const gross = sumOf(ledger, 'licenses');
    const held = pendingOf(ledger, 'licenses');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('licenses', net, options.currency));
      totals.set('licenses', net);
    }
  }

  // 18. taxes
  {
    const gross = sumOf(ledger, 'taxes');
    const held = pendingOf(ledger, 'taxes');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('taxes', net, options.currency));
      totals.set('taxes', net);
    }
  }

  // 19. refunds
  {
    const gross = sumOf(ledger, 'refunds');
    const held = pendingOf(ledger, 'refunds');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('refunds', net, options.currency));
      totals.set('refunds', net);
    }
  }

  // 20. discounts
  {
    const gross = sumOf(ledger, 'discounts');
    const held = pendingOf(ledger, 'discounts');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('discounts', net, options.currency));
      totals.set('discounts', net);
    }
  }

  // 21. interest
  {
    const gross = sumOf(ledger, 'interest');
    const held = pendingOf(ledger, 'interest');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('interest', net, options.currency));
      totals.set('interest', net);
    }
  }

  // 22. depreciation
  {
    const gross = sumOf(ledger, 'depreciation');
    const held = pendingOf(ledger, 'depreciation');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('depreciation', net, options.currency));
      totals.set('depreciation', net);
    }
  }

  // 23. maintenance
  {
    const gross = sumOf(ledger, 'maintenance');
    const held = pendingOf(ledger, 'maintenance');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('maintenance', net, options.currency));
      totals.set('maintenance', net);
    }
  }

  // 24. subscriptions
  {
    const gross = sumOf(ledger, 'subscriptions');
    const held = pendingOf(ledger, 'subscriptions');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('subscriptions', net, options.currency));
      totals.set('subscriptions', net);
    }
  }

  // 25. hardware
  {
    const gross = sumOf(ledger, 'hardware');
    const held = pendingOf(ledger, 'hardware');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('hardware', net, options.currency));
      totals.set('hardware', net);
    }
  }

  // 26. catering
  {
    const gross = sumOf(ledger, 'catering');
    const held = pendingOf(ledger, 'catering');
    const net = options.includePending
      ? gross
      : gross - held;
    if (net !== 0) {
      rows.push(formatReportRow('catering', net, options.currency));
      totals.set('catering', net);
    }
  }

  const grandTotal = [...totals.values()]
    .reduce((sum, value) => sum + value, 0);
  rows.push(formatReportRow('total', grandTotal, options.currency));
  persistReport(ledger.periodId, rows);
  return rows;
}

/** Header line for a rendered weekly report. */
export function buildWeeklyReportHeader(ledger: Ledger, options: ReportOptions): string {
  return `weekly report ${ledger.periodId} (${options.currency})`;
}
