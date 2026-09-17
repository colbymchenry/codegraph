import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src/index';

/**
 * #1520: FTS unicode61 keeps camelCase as one token. searchNodes must still
 * surface sub-word hits via name_segment_vocab.
 */
describe('searchNodes camelCase segment supplement (#1520)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('finds getShippingMethodIdFromCheckout via query "checkout"', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1520-seg-'));
    fs.writeFileSync(
      path.join(tmpDir, 'shipping.ts'),
      [
        'export function getShippingMethodIdFromCheckout(cartId: string): string {',
        '  return cartId;',
        '}',
        'export function unrelatedHelper(): void {}',
      ].join('\n'),
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const hits = cg.searchNodes('checkout', { limit: 20 });
      const names = hits.map((h) => h.node.name);
      expect(names).toContain('getShippingMethodIdFromCheckout');
    } finally {
      cg.close();
    }
  });
});
