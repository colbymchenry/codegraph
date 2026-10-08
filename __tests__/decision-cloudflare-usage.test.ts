import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDatabase } from '../src/db/sqlite-adapter';
import { DecisionCache } from '../src/decision/cache';
import { CF_USAGE_TTL_MS, getCloudflareUsage, type CloudflareUsage } from '../src/decision/cloudflare-usage';

let root: string;
let meter: DecisionCache;
const auto = { account: 'fixture', cfKey: 'cf-token', quotaPath: '' };
const payload = (used: unknown = 2000) => ({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: used } }] }] } } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cg-cf-usage-'));
  meter = new DecisionCache(join(root, 'quota.sqlite'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload()))));
});

afterEach(() => {
  meter.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

it('queries all models from UTC midnight and shares a fresh snapshot between processes', async () => {
  const usage = await getCloudflareUsage(auto, meter);
  expect(usage).toMatchObject({ status: 'free', day: '2026-10-08', usedNeurons: 2000, remainingNeurons: 8000 });
  const [url, opts] = vi.mocked(fetch).mock.calls[0];
  expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
  expect(opts).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer cf-token' } });
  const body = JSON.parse(String(opts?.body));
  expect(body.variables).toEqual({ account: 'fixture', since: '2026-10-08T00:00:00Z', until: '2026-10-08T10:00:00.000Z' });
  expect(body.query).not.toContain('model');
  expect(body).not.toHaveProperty('state');
  const other = new DecisionCache(join(root, 'quota.sqlite'));
  try { expect(await getCloudflareUsage(auto, other)).toEqual(usage); } finally { other.close(); }
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + CF_USAGE_TTL_MS);
  await getCloudflareUsage(auto, meter);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  null, {}, { data: { viewer: { accounts: [] } } },
  { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: null }] } } },
  payload(null), payload('2000'), payload(-1), payload({}),
  { ...payload(), errors: [{ message: 'not authorized' }] },
  { ...payload(), errors: {} },
])('fails closed for incomplete, malformed or unauthorized data: %j', async body => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body)));
  expect(await getCloudflareUsage(auto, meter)).toMatchObject({ status: 'unknown', usedNeurons: null, remainingNeurons: null });
});

it('accepts a valid empty aggregate as no reported usage', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [] }] } } })));
  expect(await getCloudflareUsage(auto, meter)).toMatchObject({ status: 'free', usedNeurons: 0, remainingNeurons: 10000 });
});

it('does not reuse a successful snapshot after an expired lookup fails', async () => {
  await getCloudflareUsage(auto, meter);
  vi.setSystemTime(Date.now() + CF_USAGE_TTL_MS);
  vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 403 }));
  expect(await getCloudflareUsage(auto, meter)).toMatchObject({ status: 'unknown', reason: 'http_403', remainingNeurons: null });
  await getCloudflareUsage(auto, meter);
  expect(fetch).toHaveBeenCalledTimes(2); // Failed lookups are briefly cached too.
});

it('refreshes on credential or account changes', async () => {
  await getCloudflareUsage(auto, meter);
  await getCloudflareUsage({ ...auto, cfKey: 'another-token' }, meter);
  await getCloudflareUsage({ ...auto, account: 'another-account' }, meter);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('uses a new allowance after UTC midnight and rejects a query that crosses midnight', async () => {
  vi.setSystemTime(new Date('2026-10-08T23:59:59Z'));
  await getCloudflareUsage(auto, meter);
  expect(meter.reserveNeurons(auto.account, '2026-10-08', 8000, 10000)).toBe(true);
  vi.setSystemTime(new Date('2026-10-09T00:00:01Z'));
  await getCloudflareUsage(auto, meter);
  expect(meter.reserveNeurons(auto.account, '2026-10-09', 8000, 10000)).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date('2026-10-10T23:59:59Z'));
  vi.mocked(fetch).mockImplementation(async () => {
    vi.setSystemTime(new Date('2026-10-11T00:00:01Z'));
    return new Response(JSON.stringify(payload()));
  });
  expect(await getCloudflareUsage(auto, meter)).toMatchObject({ status: 'unknown', reason: 'day_changed' });
});

it('times out without consuming the entire decision deadline', async () => {
  vi.mocked(fetch).mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
    opts!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  expect(await getCloudflareUsage(auto, meter, 10)).toMatchObject({ status: 'unknown', reason: 'timeout' });
});

it('preserves pending reservations when analytics increases, decreases, or overlaps an in-flight request', async () => {
  const day = '2026-10-08';
  const snapshot = (used: number): CloudflareUsage => ({ status: 'free', usedNeurons: used, remainingNeurons: 10000 - used, day, checkedAt: Date.now() });
  meter.putCloudflareUsage(auto.account, 'hash', snapshot(2000));
  expect(meter.reserveNeurons(auto.account, day, 1500, 10000)).toBe(true);
  meter.putCloudflareUsage(auto.account, 'hash', snapshot(8500));
  expect(meter.remainingNeurons(auto.account, day, 10000)).toBe(0);
  expect(meter.reserveNeurons(auto.account, day, 1, 10000)).toBe(false);
  meter.settleNeurons(auto.account, day, 1500, 100);
  expect(meter.remainingNeurons(auto.account, day, 10000)).toBe(1400);
  meter.putCloudflareUsage(auto.account, 'hash', snapshot(2000));
  expect(meter.remainingNeurons(auto.account, day, 10000)).toBe(1400);
  expect(meter.reserveNeurons(auto.account, day, 1401, 10000)).toBe(false);
});

it('preserves the previous ledger when upgrading its schema', () => {
  const file = join(root, 'old.sqlite');
  const { db } = createDatabase(file);
  db.exec("CREATE TABLE cf_usage (account TEXT, day TEXT, neurons REAL, PRIMARY KEY(account, day)); INSERT INTO cf_usage VALUES ('fixture', '2026-10-08', 9500)");
  db.close();
  const upgraded = new DecisionCache(file);
  try {
    expect(upgraded.reserveNeurons(auto.account, '2026-10-08', 501, 10000)).toBe(false);
    expect(upgraded.reserveNeurons(auto.account, '2026-10-08', 500, 10000)).toBe(true);
  } finally { upgraded.close(); }
});
