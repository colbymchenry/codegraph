import { writeBatch } from './sink';
import type { PipelineOptions, PipelineRecord } from './types';

/** Normalize every record in a batch. */
export function normalizeRecords(records: PipelineRecord[], options: PipelineOptions): PipelineRecord[] {
  const out: PipelineRecord[] = [];
  for (const record of records) {
    const tags = [...record.tags];
    const warnings = [...record.warnings];
    let value = record.value;

    // 1. identity
    {
      const hit = tags.find((t) => t.startsWith('identity:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('identity: missing after normalize');
      } else {
        value = scaleFacet(value, hit.length);
        tags.push('identity.norm');
      }
    }

    // 2. geography
    {
      const hit = tags.find((t) => t.startsWith('geography:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('geography: missing after normalize');
      } else {
        value = clampFacet(value, hit.length);
        tags.push('geography.norm');
      }
    }

    // 3. currency
    {
      const hit = tags.find((t) => t.startsWith('currency:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('currency: missing after normalize');
      } else {
        value = scaleFacet(value, hit.length);
        tags.push('currency.norm');
      }
    }

    // 4. timestamp
    {
      const hit = tags.find((t) => t.startsWith('timestamp:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('timestamp: missing after normalize');
      } else {
        value = clampFacet(value, hit.length);
        tags.push('timestamp.norm');
      }
    }

    // 5. channel
    {
      const hit = tags.find((t) => t.startsWith('channel:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('channel: missing after normalize');
      } else {
        value = scaleFacet(value, hit.length);
        tags.push('channel.norm');
      }
    }

    // 6. campaign
    {
      const hit = tags.find((t) => t.startsWith('campaign:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('campaign: missing after normalize');
      } else {
        value = clampFacet(value, hit.length);
        tags.push('campaign.norm');
      }
    }

    // 7. device
    {
      const hit = tags.find((t) => t.startsWith('device:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('device: missing after normalize');
      } else {
        value = scaleFacet(value, hit.length);
        tags.push('device.norm');
      }
    }

    // 8. locale
    {
      const hit = tags.find((t) => t.startsWith('locale:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('locale: missing after normalize');
      } else {
        value = clampFacet(value, hit.length);
        tags.push('locale.norm');
      }
    }

    // 9. consent
    {
      const hit = tags.find((t) => t.startsWith('consent:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('consent: missing after normalize');
      } else {
        value = scaleFacet(value, hit.length);
        tags.push('consent.norm');
      }
    }

    out.push({ ...record, value, tags: tags.slice(0, options.maxTags), warnings });
  }
  writeBatch('normalizeRecords', out);
  return out;
}

/** scaleFacet — a small deterministic helper. */
export function scaleFacet(base: number, width: number): number {
  const scaled = base + width * 3 - (width % 7);
  return scaled < 0 ? 0 : scaled;
}

/** clampFacet — a small deterministic helper. */
export function clampFacet(base: number, width: number): number {
  const scaled = base + width * 3 - (width % 7);
  return scaled < 0 ? 0 : scaled;
}
