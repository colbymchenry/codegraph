import { appendFileSync } from 'fs';
import { decisionConfig } from './config';
import type { Verdict } from './types';
import type { CloudflareUsage } from './cloudflare-usage';

export interface LedgerEntry {
  ts: number;
  point: string;
  key: string;
  backend: string;
  model: string;
  /** The model's verdict before the floor; null when there was no usable answer. */
  verdict: Verdict | null;
  /** Whether the site acted on it (verdict present and p ≥ floor). */
  applied: boolean;
  heuristic: string | null;
  latencyMs: number;
  cached: boolean;
  inputTokens: number;
  cloudflare?: CloudflareUsage;
}

/** Append one decision to CODEGRAPH_DECISION_LEDGER (JSONL). Best-effort: never throws. */
export function writeLedger(entry: LedgerEntry): void {
  const path = decisionConfig().ledgerPath;
  if (!path) return;
  try {
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    /* the ledger is an observation channel; losing a line must not change behaviour */
  }
}
