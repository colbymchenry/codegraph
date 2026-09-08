/** Table of background images for a training set — source-column rendering. */

export interface BackgroundImageRow {
  id: string;
  sourceUrl: string;
  label: string;
}

let tableRows: BackgroundImageRow[] = [];

export function loadTableRows(rows: BackgroundImageRow[]): void {
  tableRows = rows;
}

export function renderSourceColumn(row: BackgroundImageRow): string {
  return `${row.label}: ${row.sourceUrl}`;
}

export function sortRowsBySource(): BackgroundImageRow[] {
  return [...tableRows].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
}
