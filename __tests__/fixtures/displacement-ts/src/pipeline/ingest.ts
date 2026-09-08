import { scaleFacet, clampFacet } from './normalize';
import { writeBatch } from './sink';
import type { PipelineOptions, PipelineRecord, RawRecord } from './types';

/**
 * Ingest one batch of raw records.
 *
 * Every facet is unpacked in its own block so an on-call engineer can read the
 * ingest end-to-end in one place. The shape is deliberately flat: this single
 * function is the whole stage, which is exactly the shape that makes it the
 * biggest cluster member in the file.
 */
export function ingestRecords(batch: RawRecord[], options: PipelineOptions): PipelineRecord[] {
  const out: PipelineRecord[] = [];
  for (const record of batch) {
    const tags: string[] = [];
    const warnings: string[] = [];
    let value = 0;

  // 1. identity — normalise the identity facet of the record.
  {
    const raw = record.payload['identity'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('identity: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('identity:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('identity: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 2. geography — normalise the geography facet of the record.
  {
    const raw = record.payload['geography'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('geography: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('geography:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('geography: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 3. currency — normalise the currency facet of the record.
  {
    const raw = record.payload['currency'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('currency: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('currency:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('currency: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 4. timestamp — normalise the timestamp facet of the record.
  {
    const raw = record.payload['timestamp'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('timestamp: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('timestamp:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('timestamp: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 5. channel — normalise the channel facet of the record.
  {
    const raw = record.payload['channel'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('channel: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('channel:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('channel: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 6. campaign — normalise the campaign facet of the record.
  {
    const raw = record.payload['campaign'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('campaign: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('campaign:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('campaign: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 7. device — normalise the device facet of the record.
  {
    const raw = record.payload['device'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('device: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('device:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('device: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 8. locale — normalise the locale facet of the record.
  {
    const raw = record.payload['locale'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('locale: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('locale:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('locale: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 9. consent — normalise the consent facet of the record.
  {
    const raw = record.payload['consent'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('consent: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('consent:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('consent: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 10. segment — normalise the segment facet of the record.
  {
    const raw = record.payload['segment'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('segment: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('segment:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('segment: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 11. referrer — normalise the referrer facet of the record.
  {
    const raw = record.payload['referrer'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('referrer: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('referrer:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('referrer: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 12. experiment — normalise the experiment facet of the record.
  {
    const raw = record.payload['experiment'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('experiment: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('experiment:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('experiment: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 13. subscription — normalise the subscription facet of the record.
  {
    const raw = record.payload['subscription'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('subscription: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('subscription:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('subscription: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 14. entitlement — normalise the entitlement facet of the record.
  {
    const raw = record.payload['entitlement'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('entitlement: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('entitlement:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('entitlement: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 15. invoice — normalise the invoice facet of the record.
  {
    const raw = record.payload['invoice'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('invoice: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('invoice:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('invoice: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 16. refund — normalise the refund facet of the record.
  {
    const raw = record.payload['refund'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('refund: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('refund:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('refund: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 17. dispute — normalise the dispute facet of the record.
  {
    const raw = record.payload['dispute'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('dispute: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('dispute:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('dispute: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 18. payout — normalise the payout facet of the record.
  {
    const raw = record.payload['payout'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('payout: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('payout:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('payout: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 19. shipment — normalise the shipment facet of the record.
  {
    const raw = record.payload['shipment'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('shipment: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('shipment:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('shipment: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 20. inventory — normalise the inventory facet of the record.
  {
    const raw = record.payload['inventory'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('inventory: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('inventory:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('inventory: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 21. warehouse — normalise the warehouse facet of the record.
  {
    const raw = record.payload['warehouse'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('warehouse: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('warehouse:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('warehouse: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 22. carrier — normalise the carrier facet of the record.
  {
    const raw = record.payload['carrier'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('carrier: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('carrier:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('carrier: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 23. customs — normalise the customs facet of the record.
  {
    const raw = record.payload['customs'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('customs: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('customs:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('customs: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 24. tariff — normalise the tariff facet of the record.
  {
    const raw = record.payload['tariff'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('tariff: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('tariff:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('tariff: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 25. sensor — normalise the sensor facet of the record.
  {
    const raw = record.payload['sensor'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('sensor: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('sensor:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('sensor: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 26. firmware — normalise the firmware facet of the record.
  {
    const raw = record.payload['firmware'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('firmware: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('firmware:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('firmware: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 27. telemetry — normalise the telemetry facet of the record.
  {
    const raw = record.payload['telemetry'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('telemetry: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('telemetry:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('telemetry: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 28. battery — normalise the battery facet of the record.
  {
    const raw = record.payload['battery'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('battery: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('battery:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('battery: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 29. network — normalise the network facet of the record.
  {
    const raw = record.payload['network'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('network: empty, dropped');
    } else {
      const scaled = scaleFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('network:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('network: not scalable — ' + text.slice(0, 16));
      }
    }
  }

  // 30. roaming — normalise the roaming facet of the record.
  {
    const raw = record.payload['roaming'];
    const text = typeof raw === 'string' ? raw.trim() : raw === null ? '' : String(raw);
    if (text.length === 0 && options.dropEmpty) {
      warnings.push('roaming: empty, dropped');
    } else {
      const scaled = clampFacet(text.length, options.maxTags);
      if (Number.isFinite(scaled) && scaled !== 0) {
        tags.push('roaming:' + text.slice(0, 24));
        value += scaled;
      } else if (options.strict) {
        warnings.push('roaming: not scalable — ' + text.slice(0, 16));
      }
    }
  }

    out.push({
      id: record.id,
      source: record.source,
      kind: options.defaultKind,
      value,
      tags: tags.slice(0, options.maxTags),
      warnings,
    });
  }
  writeBatch('ingest', out);
  return out;
}
