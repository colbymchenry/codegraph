export interface Widget {
  id: string;
  kind: 'chart' | 'table' | 'stat';
  title: string;
  column: number;
  row: number;
  span: number;
  hidden: boolean;
}

export interface MetricSample {
  widgetId: string;
  at: number;
  value: number;
  unit: string;
}

export interface FilterSpec {
  field: string;
  op: 'eq' | 'gt' | 'lt' | 'contains';
  value: string;
}

export interface StoreDeps {
  fetchJson: (url: string) => Promise<unknown>;
  now: () => number;
  log: (message: string) => void;
}
