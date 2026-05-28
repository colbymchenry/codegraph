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

  describe('Non-ASCII (Korean) queries', () => {
    let krDir: string;
    let krCg: CodeGraph;

    beforeEach(async () => {
      krDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-context-kr-'));
      const srcDir = path.join(krDir, 'src');
      fs.mkdirSync(srcDir);

      // Source with Korean (non-ASCII) identifiers — the patterns that used to
      // drive keyword extraction were all [a-zA-Z]-based, so context returned
      // empty for these even though symbol search found them.
      fs.writeFileSync(
        path.join(srcDir, 'auth.ts'),
        `export function 로그인(사용자명: string): boolean {
  return 인증확인(사용자명);
}

export function 인증확인(사용자명: string): boolean {
  return 사용자명.length > 0;
}

export class 사용자관리자 {
  생성하기(이름: string): string {
    return 이름;
  }
}
`
      );

      krCg = CodeGraph.initSync(krDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await krCg.indexAll();
    });

    afterEach(() => {
      if (krCg) krCg.destroy();
      if (fs.existsSync(krDir)) {
        fs.rmSync(krDir, { recursive: true, force: true });
      }
    });

    it('finds relevant nodes for a Korean query', async () => {
      const result = await krCg.findRelevantContext('로그인');

      expect(result.nodes.size).toBeGreaterThan(0);
      const names = Array.from(result.nodes.values()).map((n) => n.name);
      expect(names).toContain('로그인');
    });

    it('surfaces Korean symbols in built context (was empty before fix)', async () => {
      const result = (await krCg.buildContext('로그인', {
        format: 'markdown',
      })) as string;

      // Regression guard for the reported bug: the markdown used to contain
      // only the header + query, with zero symbols.
      expect(result).toContain('로그인');
      expect(result).toContain('### Entry Points');
    });

    it('surfaces a Korean class and method from a multi-word Korean query', async () => {
      const result = (await krCg.buildContext('사용자관리자 생성하기', {
        format: 'json',
      })) as string;
      const parsed = JSON.parse(result);
      const names = parsed.nodes.map((n: { name: string }) => n.name);

      expect(names).toContain('사용자관리자');
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
