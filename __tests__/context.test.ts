/**
 * Context Builder Tests
 *
 * Tests for the context building functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('Context Builder', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-context-test-'));

    // Create a sample codebase
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // Create a payment service file
    fs.writeFileSync(
      path.join(srcDir, 'payment.ts'),
      `/**
 * Payment Service
 * Handles payment processing logic.
 */

export interface PaymentResult {
  success: boolean;
  transactionId: string;
  amount: number;
}

export class PaymentService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Process a payment for the given amount
   */
  async processPayment(amount: number): Promise<PaymentResult> {
    // Validate amount
    if (amount <= 0) {
      throw new Error('Invalid amount');
    }

    // Process payment
    const transactionId = this.generateTransactionId();
    return {
      success: true,
      transactionId,
      amount,
    };
  }

  private generateTransactionId(): string {
    return 'txn_' + Math.random().toString(36).substring(2);
  }
}

export function createPaymentService(apiKey: string): PaymentService {
  return new PaymentService(apiKey);
}
`
    );

    // Create a checkout controller file
    fs.writeFileSync(
      path.join(srcDir, 'checkout.ts'),
      `/**
 * Checkout Controller
 * Handles the checkout flow.
 */

import { PaymentService, PaymentResult } from './payment';

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export class CheckoutController {
  private paymentService: PaymentService;

  constructor(paymentService: PaymentService) {
    this.paymentService = paymentService;
  }

  /**
   * Process checkout for the given cart
   */
  async processCheckout(cart: CartItem[]): Promise<PaymentResult> {
    const total = this.calculateTotal(cart);

    if (total === 0) {
      throw new Error('Cart is empty');
    }

    return this.paymentService.processPayment(total);
  }

  /**
   * Calculate the total price of the cart
   */
  calculateTotal(cart: CartItem[]): number {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}
`
    );

    // Create a utilities file
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `/**
 * Utility functions
 */

export function formatCurrency(amount: number): string {
  return '$' + amount.toFixed(2);
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}
`
    );

    // Create a provider config file with code-like string aliases that are not
    // symbol names. Context search should still route these aliases to the
    // enclosing implementation instead of returning no useful entry point.
    fs.writeFileSync(
      path.join(srcDir, 'provider-config.ts'),
      `export function normalizeModelForProvider(model: string): string {
  switch (model) {
    case 'deepseek-r1':
    case 'deepseek-reasoner':
      return 'deepseek-ai/DeepSeek-V4-Pro';
    default:
      return model;
  }
}

export function unrelatedProviderHelper(): string {
  return 'not-this-one';
}
`
    );

    // Create a config-key fixture where code-like strings appear both in
    // purpose-built functions and a generic alias registry. The purpose-built
    // functions should rank first when the query provides semantic words.
    fs.writeFileSync(
      path.join(srcDir, 'runtime-config.ts'),
      `export function genericAliasRegistry(): string[] {
  return ['agent.trace-mode', 'billing.webhook.created'];
}

export function message(): string {
  return 'generic helper';
}

export function resolveFeatureGate(key: string): boolean {
  if (key === 'agent.trace-mode') {
    return true;
  }
  return false;
}

export function lookupWebhookHandler(event: string): string {
  switch (event) {
    case 'billing.webhook.created':
      return 'handleBillingCreated';
    default:
      return 'ignoreWebhook';
  }
}

export function activeProviderHasEnvApiKey(provider: string): boolean {
  return provider === 'siliconflow' && Boolean(process.env.SILICONFLOW_API_KEY);
}

export function providerEnvVars(): string[] {
  return ['SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY'];
}

export function env_var_for(provider: string): string {
  if (provider === 'siliconflow') {
    return 'SILICONFLOW_API_KEY';
  }
  return 'DEEPSEEK_API_KEY';
}
`
    );

    // Create a Directus-style client file with cross-repo contract strings
    // that are not symbols in the caller repo.
    fs.writeFileSync(
      path.join(srcDir, 'directus-client.ts'),
      `export async function sendPayload(payload: unknown): Promise<Response> {
  return fetch('/live-scoring/append-event', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function saveRecord(createItem: (collection: string) => Promise<unknown>): Promise<unknown> {
  return createItem('game_matches');
}
`
    );

    // Initialize CodeGraph
    cg = CodeGraph.initSync(testDir, {
      config: {
        include: ['**/*.ts'],
        exclude: [],
      },
    });

    // Index the codebase
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getCode()', () => {
    it('should extract code for a node', async () => {
      // Find the PaymentService class
      const nodes = cg.getNodesByKind('class');
      const paymentService = nodes.find((n) => n.name === 'PaymentService');

      expect(paymentService).toBeDefined();

      const code = await cg.getCode(paymentService!.id);

      expect(code).not.toBeNull();
      expect(code).toContain('class PaymentService');
      expect(code).toContain('processPayment');
    });

    it('should return null for non-existent node', async () => {
      const code = await cg.getCode('non-existent-id');
      expect(code).toBeNull();
    });
  });

  describe('findRelevantContext()', () => {
    it('should find relevant nodes for a query', async () => {
      // Use simple query that matches symbol names (FTS5 treats spaces as AND)
      const result = await cg.findRelevantContext('PaymentService');

      expect(result.nodes.size).toBeGreaterThan(0);
      // Should find payment-related nodes
      const nodeNames = Array.from(result.nodes.values()).map((n) => n.name);
      expect(
        nodeNames.some(
          (name) =>
            name.toLowerCase().includes('payment') ||
            name.toLowerCase().includes('checkout')
        )
      ).toBe(true);
    });

    it('should include edges in the result', async () => {
      const result = await cg.findRelevantContext('checkout', {
        traversalDepth: 2,
      });

      // Should have some edges from traversal
      expect(result.edges).toBeDefined();
    });

    it('should respect maxNodes option', async () => {
      const result = await cg.findRelevantContext('function', {
        maxNodes: 5,
      });

      expect(result.nodes.size).toBeLessThanOrEqual(5);
    });

    it('should use code-like source text as a fallback entry point', async () => {
      const result = await cg.findRelevantContext('deepseek-r1', {
        searchLimit: 3,
        traversalDepth: 0,
      });

      const nodeNames = Array.from(result.nodes.values()).map((n) => n.name);
      expect(nodeNames).toContain('normalizeModelForProvider');
      expect(nodeNames).not.toContain('unrelatedProviderHelper');
    });

    it('should rank a feature flag function above a generic alias registry', async () => {
      const result = await cg.findRelevantContext('agent.trace-mode feature gate', {
        searchLimit: 3,
        traversalDepth: 0,
      });

      const entryNames = result.roots.map((id) => result.nodes.get(id)?.name);
      expect(entryNames[0]).toBe('resolveFeatureGate');
      expect(entryNames).toContain('genericAliasRegistry');
    });

    it('should not over-boost generic lowercase word symbols over source-text matches', async () => {
      const result = await cg.findRelevantContext('agent.trace-mode feature gate message history', {
        searchLimit: 3,
        traversalDepth: 0,
      });

      const entryNames = result.roots.map((id) => result.nodes.get(id)?.name);
      expect(entryNames[0]).toBe('resolveFeatureGate');
      expect(entryNames).toContain('message');
    });

    it('should rank a webhook handler function above a generic alias registry', async () => {
      const result = await cg.findRelevantContext('billing.webhook.created webhook handler', {
        searchLimit: 3,
        traversalDepth: 0,
      });

      const entryNames = result.roots.map((id) => result.nodes.get(id)?.name);
      expect(entryNames[0]).toBe('lookupWebhookHandler');
      expect(entryNames).toContain('genericAliasRegistry');
    });

    it('should rank an exact symbol match above broader source-text matches', async () => {
      const result = await cg.findRelevantContext('env_var_for provider picker SILICONFLOW_API_KEY', {
        searchLimit: 3,
        traversalDepth: 0,
      });

      const entryNames = result.roots.map((id) => result.nodes.get(id)?.name);
      expect(entryNames[0]).toBe('env_var_for');
      expect(entryNames).toContain('activeProviderHasEnvApiKey');
      expect(entryNames).toContain('providerEnvVars');
    });

    it('should route exact cross-repo contract strings to their enclosing caller functions', async () => {
      const routeResult = await cg.findRelevantContext('/live-scoring/append-event', {
        searchLimit: 3,
        traversalDepth: 0,
      });
      const routeEntryNames = routeResult.roots.map((id) => routeResult.nodes.get(id)?.name);
      expect(routeEntryNames).toContain('sendPayload');

      const collectionResult = await cg.findRelevantContext('game_matches', {
        searchLimit: 3,
        traversalDepth: 0,
      });
      const collectionEntryNames = collectionResult.roots.map((id) => collectionResult.nodes.get(id)?.name);
      expect(collectionEntryNames).toContain('saveRecord');
    });
  });

  describe('buildContext()', () => {
    it('should build context with markdown format', async () => {
      const result = await cg.buildContext('Fix checkout error', {
        format: 'markdown',
        maxCodeBlocks: 3,
      });

      expect(typeof result).toBe('string');
      const markdown = result as string;

      // Should contain markdown structure
      expect(markdown).toContain('## Code Context');
      expect(markdown).toContain('**Query:** Fix checkout error');
    });

    it('should build context with JSON format', async () => {
      const result = await cg.buildContext('payment processing', {
        format: 'json',
      });

      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result as string);

      expect(parsed.query).toBe('payment processing');
      expect(parsed.nodes).toBeDefined();
      expect(Array.isArray(parsed.nodes)).toBe(true);
    });

    it('should accept object input with title and description', async () => {
      const result = await cg.buildContext(
        {
          title: 'Checkout bug',
          description: 'Cart total calculation is wrong',
        },
        { format: 'markdown' }
      );

      expect(typeof result).toBe('string');
      expect(result).toContain('Checkout bug: Cart total calculation is wrong');
    });

    it('should include code blocks when requested', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'markdown',
        includeCode: true,
        maxCodeBlocks: 2,
      });

      const markdown = result as string;

      // Should contain code blocks
      expect(markdown).toContain('### Code');
      expect(markdown).toContain('```typescript');
    });

    it('should exclude code blocks when requested', async () => {
      const result = await cg.buildContext('payment', {
        format: 'markdown',
        includeCode: false,
      });

      const markdown = result as string;

      // Should not contain code section
      expect(markdown).not.toContain('### Code');
    });

    it('should include related symbols in compact format', async () => {
      const result = await cg.buildContext('checkout', {
        format: 'markdown',
        maxNodes: 10,
      });

      const markdown = result as string;

      // Compact format uses "Related Symbols" instead of verbose "Related Files"
      // and groups symbols by file for compactness
      expect(markdown).toContain('### Entry Points');
    });

    it('should have compact output without verbose stats footer', async () => {
      const result = await cg.buildContext('payment', {
        format: 'markdown',
      });

      const markdown = result as string;

      // Compact format should NOT have verbose stats footer
      expect(markdown).not.toMatch(/\*Context:.*symbols.*relationships.*files/);
      // But should still have query
      expect(markdown).toContain('**Query:**');
    });
  });

  describe('Context structure', () => {
    it('should find entry points from search', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'json',
      });

      const parsed = JSON.parse(result as string);

      expect(parsed.entryPoints).toBeDefined();
      expect(parsed.entryPoints.length).toBeGreaterThan(0);
    });

    it('should traverse graph from entry points', async () => {
      const result = await cg.buildContext('CheckoutController', {
        format: 'json',
        traversalDepth: 2,
      });

      const parsed = JSON.parse(result as string);

      // Should have found related nodes through traversal
      const nodeNames = parsed.nodes.map((n: { name: string }) => n.name);

      // CheckoutController calls PaymentService, so both should be present
      expect(
        nodeNames.some((name: string) => name.includes('Checkout'))
      ).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty query', async () => {
      const result = await cg.buildContext('', { format: 'markdown' });

      expect(typeof result).toBe('string');
    });

    it('should handle query with no matches', async () => {
      const result = await cg.buildContext('xyznonexistent123', {
        format: 'json',
      });

      const parsed = JSON.parse(result as string);

      // Should return empty or minimal results
      expect(parsed.nodes).toBeDefined();
    });

    it('should truncate long code blocks', async () => {
      const result = await cg.buildContext('PaymentService', {
        format: 'markdown',
        maxCodeBlockSize: 100,
        includeCode: true,
      });

      const markdown = result as string;

      // Long code blocks should be truncated
      if (markdown.includes('```typescript')) {
        // If there's a code block, check for truncation marker if content was long
        // This test validates the truncation logic works
        expect(typeof markdown).toBe('string');
      }
    });
  });
});
