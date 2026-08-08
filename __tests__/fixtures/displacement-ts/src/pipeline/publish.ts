import { writeBatch } from './sink';
import type { PipelineOptions, PipelineRecord } from './types';

/** Publish every record in a batch. */
export function publishRecords(records: PipelineRecord[], options: PipelineOptions): PipelineRecord[] {
  const out: PipelineRecord[] = [];
  for (const record of records) {
    const tags = [...record.tags];
    const warnings = [...record.warnings];
    let value = record.value;

    // 1. shipment
    {
      const hit = tags.find((t) => t.startsWith('shipment:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('shipment: missing after publish');
      } else {
        value = rankFacet(value, hit.length);
        tags.push('shipment.publ');
      }
    }

    // 2. inventory
    {
      const hit = tags.find((t) => t.startsWith('inventory:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('inventory: missing after publish');
      } else {
        value = sealFacet(value, hit.length);
        tags.push('inventory.publ');
      }
    }

    // 3. warehouse
    {
      const hit = tags.find((t) => t.startsWith('warehouse:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('warehouse: missing after publish');
      } else {
        value = rankFacet(value, hit.length);
        tags.push('warehouse.publ');
      }
    }

    // 4. carrier
    {
      const hit = tags.find((t) => t.startsWith('carrier:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('carrier: missing after publish');
      } else {
        value = sealFacet(value, hit.length);
        tags.push('carrier.publ');
      }
    }

    // 5. customs
    {
      const hit = tags.find((t) => t.startsWith('customs:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('customs: missing after publish');
      } else {
        value = rankFacet(value, hit.length);
        tags.push('customs.publ');
      }
    }

    // 6. tariff
    {
      const hit = tags.find((t) => t.startsWith('tariff:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('tariff: missing after publish');
      } else {
        value = sealFacet(value, hit.length);
        tags.push('tariff.publ');
      }
    }

    // 7. sensor
    {
      const hit = tags.find((t) => t.startsWith('sensor:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('sensor: missing after publish');
      } else {
        value = rankFacet(value, hit.length);
        tags.push('sensor.publ');
      }
    }

    // 8. firmware
    {
      const hit = tags.find((t) => t.startsWith('firmware:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('firmware: missing after publish');
      } else {
        value = sealFacet(value, hit.length);
        tags.push('firmware.publ');
      }
    }

    // 9. telemetry
    {
      const hit = tags.find((t) => t.startsWith('telemetry:'));
      if (hit === undefined) {
        if (options.strict) warnings.push('telemetry: missing after publish');
      } else {
        value = rankFacet(value, hit.length);
        tags.push('telemetry.publ');
      }
    }

    out.push({ ...record, value, tags: tags.slice(0, options.maxTags), warnings });
  }
  writeBatch('publishRecords', out);
  return out;
}

/** rankFacet — a small deterministic helper. */
export function rankFacet(base: number, width: number): number {
  const scaled = base + width * 3 - (width % 7);
  return scaled < 0 ? 0 : scaled;
}

/** sealFacet — a small deterministic helper. */
export function sealFacet(base: number, width: number): number {
  const scaled = base + width * 3 - (width % 7);
  return scaled < 0 ? 0 : scaled;
}
