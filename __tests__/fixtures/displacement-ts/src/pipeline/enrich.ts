import { writeBatch } from './sink';
import type { PipelineOptions, PipelineRecord } from './types';

/** Enrich every record in a batch. */
export function enrichRecords(records: PipelineRecord[], options: PipelineOptions): PipelineRecord[] {
  const out: PipelineRecord[] = [];
  for (const record of records) {
    const tags = [...record.tags];
    const warnings = [...record.warnings];
    let value = record.value;

    // 1. segment
    {
      const hit = tags.find((t) => t.startsWith('segment:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('segment: missing after enrich');
      } else {
        value = weightFacet(value, hit.length);
        tags.push('segment.enri');
      }
    }

    // 2. referrer
    {
      const hit = tags.find((t) => t.startsWith('referrer:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('referrer: missing after enrich');
      } else {
        value = blendFacet(value, hit.length);
        tags.push('referrer.enri');
      }
    }

    // 3. experiment
    {
      const hit = tags.find((t) => t.startsWith('experiment:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('experiment: missing after enrich');
      } else {
        value = weightFacet(value, hit.length);
        tags.push('experiment.enri');
      }
    }

    // 4. subscription
    {
      const hit = tags.find((t) => t.startsWith('subscription:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('subscription: missing after enrich');
      } else {
        value = blendFacet(value, hit.length);
        tags.push('subscription.enri');
      }
    }

    // 5. entitlement
    {
      const hit = tags.find((t) => t.startsWith('entitlement:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('entitlement: missing after enrich');
      } else {
        value = weightFacet(value, hit.length);
        tags.push('entitlement.enri');
      }
    }

    // 6. invoice
    {
      const hit = tags.find((t) => t.startsWith('invoice:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('invoice: missing after enrich');
      } else {
        value = blendFacet(value, hit.length);
        tags.push('invoice.enri');
      }
    }

    // 7. refund
    {
      const hit = tags.find((t) => t.startsWith('refund:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('refund: missing after enrich');
      } else {
        value = weightFacet(value, hit.length);
        tags.push('refund.enri');
      }
    }

    // 8. dispute
    {
      const hit = tags.find((t) => t.startsWith('dispute:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('dispute: missing after enrich');
      } else {
        value = blendFacet(value, hit.length);
        tags.push('dispute.enri');
      }
    }

    // 9. payout
    {
      const hit = tags.find((t) => t.startsWith('payout:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('payout: missing after enrich');
      } else {
        value = weightFacet(value, hit.length);
        tags.push('payout.enri');
      }
    }

    out.push({ ...record, value, tags: tags.slice(0, options.maxTags), warnings });
  }
  writeBatch('enrichRecords', out);
  return out;
}

/** weightFacet — a small deterministic helper. */
export function weightFacet(base: number, width: number): number {
  const scaled = base + width * 3 - (width % 7);
  return scaled < 0 ? 0 : scaled;
}

/** blendFacet — a small deterministic helper. */
export function blendFacet(base: number, width: number): number {
  const scaled = base + width * 3 - (width % 7);
  return scaled < 0 ? 0 : scaled;
}
