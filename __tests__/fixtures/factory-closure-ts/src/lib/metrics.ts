import type { MetricSample } from '../stores/types';

/** Statistics helpers shared by the store and the panel. */

export function meanOf(samples: readonly MetricSample[]): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample.value;
  return total / samples.length;
}

export function medianOf(samples: readonly MetricSample[]): number {
  if (samples.length === 0) return 0;
  const values = samples.map((s) => s.value).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
}

export function rateOfChange(samples: readonly MetricSample[]): number {
  if (samples.length < 2) return 0;
  const ordered = samples.slice().sort((a, b) => a.at - b.at);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const elapsed = last.at - first.at;
  return elapsed > 0 ? (last.value - first.value) / elapsed : 0;
}

export function bucketByHour(samples: readonly MetricSample[]): Map<number, MetricSample[]> {
  const buckets = new Map<number, MetricSample[]>();
  for (const sample of samples) {
    const hour = Math.floor(sample.at / 3_600_000);
    const bucket = buckets.get(hour);
    if (bucket) bucket.push(sample);
    else buckets.set(hour, [sample]);
  }
  return buckets;
}
