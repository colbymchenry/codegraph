/**
 * Architectural and Complexity Metrics Module
 *
 * Computes software architecture metrics:
 * - Afferent Coupling (Ca): Incoming dependencies to a module/file
 * - Efferent Coupling (Ce): Outgoing dependencies from a module/file
 * - Instability Index (I): Ce / (Ca + Ce), measuring architectural stability (0 = stable, 1 = volatile)
 * - Hotspot Analysis: High fan-in / high fan-out / large blast radius symbols
 */

import type { Node } from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from './traversal';

export interface FileCouplingMetric {
  filePath: string;
  afferentCoupling: number; // Ca (incoming from other files)
  efferentCoupling: number; // Ce (outgoing to other files)
  instability: number;      // I = Ce / (Ca + Ce), 0 to 1 (0 = stable, 1 = unstable)
  symbolsCount: number;
}

export interface SymbolHotspotMetric {
  id: string;
  name: string;
  kind: Node['kind'];
  filePath: string;
  startLine?: number;
  fanIn: number;       // Incoming references / callers
  fanOut: number;      // Outgoing calls / references
  blastRadius: number; // Affected nodes within depth 2
}

export interface ProjectMetrics {
  summary: {
    totalFiles: number;
    totalSymbols: number;
    totalEdges: number;
    avgAfferentCoupling: number;
    avgEfferentCoupling: number;
    avgInstability: number;
  };
  fileMetrics: FileCouplingMetric[];
  topHotspots: SymbolHotspotMetric[];
}

export class MetricsAnalyzer {
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
    this.traverser = new GraphTraverser(queries);
  }

  /**
   * Compute file-level coupling and instability metrics
   */
  computeFileMetrics(): FileCouplingMetric[] {
    const files = this.queries.getAllFiles();
    const result: FileCouplingMetric[] = [];

    for (const file of files) {
      const incomingFiles = this.queries.getDependentFilePaths(file.path);
      const outgoingFiles = this.queries.getDependencyFilePaths(file.path);

      const ca = incomingFiles.length;
      const ce = outgoingFiles.length;
      const totalCoupling = ca + ce;
      const instability = totalCoupling === 0 ? 0 : parseFloat((ce / totalCoupling).toFixed(3));

      result.push({
        filePath: file.path,
        afferentCoupling: ca,
        efferentCoupling: ce,
        instability,
        symbolsCount: file.nodeCount || 0,
      });
    }

    // Sort by total coupling (Ca + Ce) descending
    return result.sort(
      (a, b) => (b.afferentCoupling + b.efferentCoupling) - (a.afferentCoupling + a.efferentCoupling)
    );
  }

  /**
   * Find structural hotspots (symbols with high fan-in, high fan-out, or large blast radius)
   */
  findHotspots(limit: number = 15): SymbolHotspotMetric[] {
    const callableKinds: Node['kind'][] = ['function', 'method', 'class', 'struct', 'interface'];
    const candidates: SymbolHotspotMetric[] = [];

    for (const kind of callableKinds) {
      const nodes = this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        const incoming = this.queries.getIncomingEdges(node.id).filter((e) => e.kind !== 'contains');
        const outgoing = this.queries.getOutgoingEdges(node.id).filter((e) => e.kind !== 'contains');

        const fanIn = incoming.length;
        const fanOut = outgoing.length;

        // Only evaluate if it has at least some coupling
        if (fanIn >= 2 || fanOut >= 3) {
          const impact = this.traverser.getImpactRadius(node.id, 2);
          candidates.push({
            id: node.id,
            name: node.name,
            kind: node.kind,
            filePath: node.filePath,
            startLine: node.startLine,
            fanIn,
            fanOut,
            blastRadius: impact.nodes.size,
          });
        }
      }
    }

    // Rank hotspots by score: (fanIn * 2) + fanOut + (blastRadius * 1.5)
    candidates.sort((a, b) => {
      const scoreA = a.fanIn * 2 + a.fanOut + a.blastRadius * 1.5;
      const scoreB = b.fanIn * 2 + b.fanOut + b.blastRadius * 1.5;
      return scoreB - scoreA;
    });

    return candidates.slice(0, limit);
  }

  /**
   * Compute comprehensive project metrics
   */
  getProjectMetrics(hotspotLimit: number = 15): ProjectMetrics {
    const fileMetrics = this.computeFileMetrics();
    const topHotspots = this.findHotspots(hotspotLimit);
    const files = this.queries.getAllFiles();
    const counts = this.queries.getNodeAndEdgeCount();

    const totalFiles = files.length;
    const totalSymbols = counts.nodes;
    const totalEdges = counts.edges;

    let sumCa = 0;
    let sumCe = 0;
    let sumI = 0;

    for (const fm of fileMetrics) {
      sumCa += fm.afferentCoupling;
      sumCe += fm.efferentCoupling;
      sumI += fm.instability;
    }

    const avgCa = totalFiles > 0 ? parseFloat((sumCa / totalFiles).toFixed(2)) : 0;
    const avgCe = totalFiles > 0 ? parseFloat((sumCe / totalFiles).toFixed(2)) : 0;
    const avgI = totalFiles > 0 ? parseFloat((sumI / totalFiles).toFixed(3)) : 0;

    return {
      summary: {
        totalFiles,
        totalSymbols,
        totalEdges,
        avgAfferentCoupling: avgCa,
        avgEfferentCoupling: avgCe,
        avgInstability: avgI,
      },
      fileMetrics,
      topHotspots,
    };
  }
}
