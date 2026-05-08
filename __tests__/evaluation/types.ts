import type { NodeKind } from '../../src/types.js';

export interface EvalTestCase {
  id: string;
  query: string;
  api: 'searchNodes' | 'findRelevantContext';
  expectedSymbols: string[];
  kinds?: NodeKind[];
  options?: Record<string, unknown>;
}

export interface EvalResult {
  caseId: string;
  pass: boolean;
  recall: number;
  mrr: number;
  foundSymbols: string[];
  missedSymbols: string[];
  nodeCount?: number;
  edgeCount?: number;
  edgeDensity?: number;
  latencyMs: number;
}

export interface EvalReport {
  timestamp: string;
  codebasePath: string;
  codegraphSha: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    meanRecall: number;
    meanMRR: number;
  };
  results: EvalResult[];
}
