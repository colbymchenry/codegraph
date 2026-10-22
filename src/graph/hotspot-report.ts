import * as path from 'node:path';
import type CodeGraph from '../index';
import { isTestFile } from '../search/query-utils';
import { computeFileComplexities, supportsHotspots, scoreHotspot, rankHotspots, DEFAULT_HOTSPOT_ITEMS, DEFAULT_HOTSPOT_FILES, DEFAULT_HOTSPOT_THRESHOLD, type HotspotRow } from './hotspots';

export interface RiskHotspotOptions {
  maxFiles?: number;
  maxItems?: number;
  threshold?: number;
  changedFiles?: string[];
}
export interface RiskHotspotReport {
  items: HotspotRow[];
  scoredSymbols: number;
  eligibleFiles: number;
  scannedFiles: number;
  skippedFiles: string[];
  truncated: boolean;
  threshold: number;
  aboveThreshold: number;
}

export async function riskHotspots(graph: CodeGraph, options: RiskHotspotOptions = {}): Promise<RiskHotspotReport> {
  const maxFiles = options.maxFiles ?? DEFAULT_HOTSPOT_FILES;
  const maxItems = options.maxItems ?? DEFAULT_HOTSPOT_ITEMS;
  const threshold = options.threshold ?? DEFAULT_HOTSPOT_THRESHOLD;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 2000 || !Number.isInteger(maxItems) || maxItems < 0 || maxItems > 2000 || !Number.isFinite(threshold) || threshold < 0) {
    throw new Error('maxFiles must be 1-2000, maxItems 0-2000, and threshold finite and nonnegative.');
  }
  const files = graph.getFiles().filter(file => supportsHotspots(file.language) && !isTestFile(file.path)).sort((a, b) => a.path.localeCompare(b.path));
  const changed = new Set((options.changedFiles ?? []).map(file => file.replaceAll('\\', '/')));
  const tests = new Map<string, Set<string>>();
  for (const pair of graph.getFileDependencyPairs(0.6)) {
    if (!isTestFile(pair.source)) continue;
    if (!tests.has(pair.target)) tests.set(pair.target, new Set());
    tests.get(pair.target)!.add(pair.source);
  }
  const rows: HotspotRow[] = [];
  const skippedFiles: string[] = [];
  let scannedFiles = 0;
  for (const file of files.slice(0, maxFiles)) {
    const nodes = graph.getNodesInFile(file.path).filter(node => ['function', 'method', 'constructor', 'lambda'].includes(node.kind));
    if (!nodes.length) continue;
    const complexities = await computeFileComplexities(path.join(graph.getProjectRoot(), file.path), file.language!, nodes, undefined, file.contentHash);
    if (!complexities.size) { skippedFiles.push(file.path); continue; }
    scannedFiles++;
    const callers = new Map<string, Set<string>>();
    for (const edge of graph.getIncomingEdgesTo(nodes.map(node => node.id), ['calls'])) {
      const confidence = typeof edge.metadata?.confidence === 'number' ? edge.metadata.confidence : 1;
      if (confidence < 0.6 || edge.source === edge.target) continue;
      if (!callers.has(edge.target)) callers.set(edge.target, new Set());
      callers.get(edge.target)!.add(edge.source);
    }
    const testFiles = [...(tests.get(file.path) ?? [])].sort();
    for (const node of nodes) {
      const complexity = complexities.get(node.id);
      if (complexity === undefined) continue;
      const signals = { complexity, callerCount: callers.get(node.id)?.size ?? 0, changed: changed.has(file.path), hasTests: testFiles.length > 0 };
      rows.push({ node, ...signals, testFiles, score: scoreHotspot(signals) });
    }
  }
  const items = rankHotspots(rows, maxItems);
  return { items, scoredSymbols: rows.length, eligibleFiles: files.length, scannedFiles, skippedFiles, truncated: files.length > maxFiles || rows.length > items.length, threshold, aboveThreshold: rows.filter(row => row.score >= threshold).length };
}
