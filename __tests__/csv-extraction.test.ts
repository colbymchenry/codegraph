/**
 * Unit tests for src/extraction/csv-extractor.ts
 * Covers: ir.model.access.csv (existing behavior), model data CSV detection,
 * and model data CSV field ref extraction.
 */

import { describe, it, expect } from 'vitest';
import { CsvExtractor } from '../src/extraction/csv-extractor';

function extract(filePath: string, source: string) {
  return new CsvExtractor(filePath, source).extract();
}

// ---------------------------------------------------------------------------
// Existing behavior — ir.model.access.csv
// ---------------------------------------------------------------------------

describe('CsvExtractor — ir.model.access.csv (existing behavior)', () => {
  const ACCESS_CSV = [
    'id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink',
    'access_account_move_user,account.move user,model_account_move,account.group_account_user,1,1,1,0',
  ].join('\n');

  it('isOdooAccessFile returns true', () => {
    expect(new CsvExtractor('security/ir.model.access.csv', ACCESS_CSV).isOdooAccessFile()).toBe(true);
  });

  it('isModelDataFile returns false for ir.model.access.csv', () => {
    expect(new CsvExtractor('security/ir.model.access.csv', ACCESS_CSV).isModelDataFile()).toBe(false);
  });

  it('emits one method node per access rule row', () => {
    const result = extract('security/ir.model.access.csv', ACCESS_CSV);
    const methods = result.nodes.filter((n) => n.kind === 'method');
    expect(methods).toHaveLength(1);
    expect(methods[0]!.qualifiedName).toBe('ir.model.access::access_account_move_user');
  });

  it('emits model_id reference from access rule', () => {
    const result = extract('security/ir.model.access.csv', ACCESS_CSV);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('model_account_move');
  });
});

// ---------------------------------------------------------------------------
// Spec 3.1 — Model data CSV detection by filename
// ---------------------------------------------------------------------------

describe('CsvExtractor — isModelDataFile detection (spec 3.1)', () => {
  it('detects tipo.detraccion.csv as model data', () => {
    expect(new CsvExtractor('data/tipo.detraccion.csv', '').isModelDataFile()).toBe(true);
  });

  it('detects account.move.csv as model data', () => {
    expect(new CsvExtractor('data/account.move.csv', '').isModelDataFile()).toBe(true);
  });

  it('detects res.partner.category.csv as model data', () => {
    expect(new CsvExtractor('data/res.partner.category.csv', '').isModelDataFile()).toBe(true);
  });

  it('does NOT flag ir.model.access.csv as model data', () => {
    expect(new CsvExtractor('security/ir.model.access.csv', '').isModelDataFile()).toBe(false);
  });

  it('does NOT flag plain-stem CSV (no dot) as model data', () => {
    expect(new CsvExtractor('data/partners.csv', '').isModelDataFile()).toBe(false);
  });

  it('does NOT flag upper-case stem as model data', () => {
    expect(new CsvExtractor('data/Account.Move.csv', '').isModelDataFile()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Spec 3.2 — Model data CSV extraction: model ref + field refs
// ---------------------------------------------------------------------------

describe('CsvExtractor — model data CSV extraction (spec 3.2)', () => {
  const MODEL_CSV = ['id,name,anexo,code', 'tipo_detraccion_001,Deposito Detraccion,010,001'].join('\n');

  it('emits unresolved ref to model name derived from filename', () => {
    const result = extract('data/tipo.detraccion.csv', MODEL_CSV);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('tipo.detraccion');
  });

  it('emits field refs for each non-id header column', () => {
    const result = extract('data/tipo.detraccion.csv', MODEL_CSV);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('name');
    expect(refs).toContain('anexo');
    expect(refs).toContain('code');
  });

  it('does NOT emit ref for id column', () => {
    const result = extract('data/tipo.detraccion.csv', MODEL_CSV);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).not.toContain('id');
  });

  it('skips :id suffixed columns', () => {
    const csv = ['id,partner_id:id,name', 'rec_1,base.res_partner_1,Test'].join('\n');
    const result = extract('data/res.partner.csv', csv);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('name');
    expect(refs).not.toContain('partner_id:id');
  });

  it('skips /id suffixed columns', () => {
    const csv = ['id,categ_id/id,name', 'rec_1,product.categ_all,Widget'].join('\n');
    const result = extract('data/product.template.csv', csv);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('name');
    expect(refs).not.toContain('categ_id/id');
  });
});
