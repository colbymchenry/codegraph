/** One posted ledger entry. */
export interface LedgerEntry {
  id: string;
  category: string;
  amountCents: number;
  pending: boolean;
  postedAt: string;
}

/** A period's ledger. */
export interface Ledger {
  periodId: string;
  entries: LedgerEntry[];
}

/** How a report should be built. */
export interface ReportOptions {
  currency: string;
  includePending: boolean;
  includeEmptyCategories: boolean;
}

/** One rendered report line. */
export interface ReportRow {
  category: string;
  amount: string;
  currency: string;
}
