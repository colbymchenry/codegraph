/**
 * Secondary Development Features Test Suite
 *
 * Tests for the newly implemented features:
 * 1. Visual Graph Exporter (Mermaid, DOT, JSON)
 * 2. Architectural & Coupling Metrics (Afferent/Efferent coupling, Instability, Hotspots)
 * 3. Dead Code & Circular Dependency Auditor (auditProject)
 * 4. MCP Tool Handlers (codegraph_export, codegraph_metrics)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph, {
  exportGraph,
  exportToMermaid,
  exportToDot,
  exportToJson,
  MetricsAnalyzer,
} from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('Secondary Development Features', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-feat-test-'));

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // File A: auth service
    fs.writeFileSync(
      path.join(srcDir, 'auth.ts'),
      `
export class AuthService {
  login(token: string): boolean {
    return this.validate(token);
  }

  validate(token: string): boolean {
    return token.length > 0;
  }
}

// Dead internal helper
function unusedAuthSecret(): string {
  return 'secret_123';
}
`
    );

    // File B: user controller calling auth
    fs.writeFileSync(
      path.join(srcDir, 'controller.ts'),
      `
import { AuthService } from './auth';

export class UserController {
  private auth: AuthService;

  constructor() {
    this.auth = new AuthService();
  }

  handleLogin(t: string): boolean {
    return this.auth.login(t);
  }
}
`
    );

    // File C: app entrypoint calling controller
    fs.writeFileSync(
      path.join(srcDir, 'app.ts'),
      `
import { UserController } from './controller';

export function bootstrap(): void {
  const controller = new UserController();
  controller.handleLogin('test_token');
}
`
    );

    cg = CodeGraph.initSync(testDir, {
      config: {
        include: ['src/**/*.ts'],
        exclude: [],
      },
    });

    await cg.indexAll();
    cg.resolveReferences();
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    }
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore Windows temp file release delay
    }
  });

  describe('Feature 1: Visual Graph Exporter', () => {
    it('exports a subgraph to Mermaid markdown diagram', () => {
      const controllerNode = cg.getNodesByName('UserController')[0];
      expect(controllerNode).toBeDefined();

      const callGraph = cg.getCallGraph(controllerNode!.id, 2);
      const mermaid = exportToMermaid(callGraph, { direction: 'TD', title: 'User Controller Graph' });

      expect(mermaid).toContain('graph TD');
      expect(mermaid).toContain('title: User Controller Graph');
      expect(mermaid).toContain('UserController');
    });

    it('exports a subgraph to Graphviz DOT format', () => {
      const authNode = cg.getNodesByName('AuthService')[0];
      expect(authNode).toBeDefined();

      const impact = cg.getImpactRadius(authNode!.id, 2);
      const dot = exportToDot(impact, { title: 'AuthImpact' });

      expect(dot).toContain('digraph AuthImpact {');
      expect(dot).toContain('AuthService');
      expect(dot).toContain('}');
    });

    it('exports a subgraph to JSON Graph format', () => {
      const appNode = cg.getNodesByName('bootstrap')[0];
      expect(appNode).toBeDefined();

      const callGraph = cg.getCallGraph(appNode!.id, 2);
      const jsonStr = exportToJson(callGraph);
      const parsed = JSON.parse(jsonStr);

      expect(parsed).toHaveProperty('nodeCount');
      expect(parsed).toHaveProperty('nodes');
      expect(parsed).toHaveProperty('edges');
      expect(parsed.nodes.some((n: any) => n.name === 'bootstrap')).toBe(true);
    });

    it('exports symbol graph directly via CodeGraph API', () => {
      const output = cg.exportSymbolGraph('AuthService', {
        format: 'mermaid',
        depth: 2,
      });

      expect(output).toContain('graph TD');
      expect(output).toContain('AuthService');
    });
  });

  describe('Feature 2: Architectural & Coupling Metrics', () => {
    it('calculates file coupling and instability index', () => {
      const analyzer = new MetricsAnalyzer((cg as any).queries);
      const fileMetrics = analyzer.computeFileMetrics();

      expect(fileMetrics.length).toBe(3);

      const authMetric = fileMetrics.find((m) => m.filePath.endsWith('auth.ts'));
      expect(authMetric).toBeDefined();
      // auth.ts is depended upon by controller.ts (Ca >= 1)
      expect(authMetric!.afferentCoupling).toBeGreaterThanOrEqual(1);

      const appMetric = fileMetrics.find((m) => m.filePath.endsWith('app.ts'));
      expect(appMetric).toBeDefined();
      // app.ts depends on controller.ts (Ce >= 1)
      expect(appMetric!.efferentCoupling).toBeGreaterThanOrEqual(1);
    });

    it('identifies structural hotspots and computes project summary', () => {
      const metrics = cg.getMetrics(5);

      expect(metrics.summary.totalFiles).toBe(3);
      expect(metrics.summary.totalSymbols).toBeGreaterThan(0);
      expect(typeof metrics.summary.avgAfferentCoupling).toBe('number');
      expect(typeof metrics.summary.avgInstability).toBe('number');
    });
  });

  describe('Feature 3: Dead Code & Circular Dependency Audit', () => {
    it('detects unreferenced non-exported functions as dead code', () => {
      const audit = cg.auditProject();

      expect(audit.deadCode.length).toBeGreaterThan(0);
      const deadNames = audit.deadCode.map((n) => n.name);
      expect(deadNames).toContain('unusedAuthSecret');
    });

    it('reports zero circular dependencies on clean acyclic architecture', () => {
      const audit = cg.auditProject();
      expect(audit.circularDependencies.length).toBe(0);
    });
  });

  describe('Feature 4: MCP Tool Suite Extension', () => {
    let handler: ToolHandler;

    beforeEach(() => {
      handler = new ToolHandler(cg);
    });

    it('executes codegraph_export MCP tool successfully', async () => {
      const result = await handler.execute('codegraph_export', {
        symbol: 'UserController',
        format: 'mermaid',
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('graph TD');
      expect(text).toContain('UserController');
    });

    it('exports all indexed files in project mode', async () => {
      for (let i = 1; i <= 31; i++) {
        fs.writeFileSync(
          path.join(testDir, 'src', `extra-${i}.ts`),
          `export function extra${i}(): number { return ${i}; }\n`
        );
      }
      await cg.indexAll();
      cg.resolveReferences();

      const result = await handler.execute('codegraph_export', {});

      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('extra-31.ts');
    });

    it('executes codegraph_metrics MCP tool successfully', async () => {
      const result = await handler.execute('codegraph_metrics', {
        limit: 5,
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Project Architecture Metrics');
      expect(text).toContain('Total Files:');
      expect(text).toContain('Instability Index');
    });
  });
});
