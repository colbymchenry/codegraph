import { createHash } from 'crypto';
import type { DecisionCache } from './cache';
import type { DecisionConfig } from './config';
import { CF_DAILY_FREE_NEURONS } from './policy';

export interface CloudflareUsage {
  status: 'free' | 'exhausted' | 'unknown';
  day: string;
  checkedAt: number;
  usedNeurons: number | null;
  remainingNeurons: number | null;
  reason?: string;
}

export const CF_USAGE_TTL_MS = 30_000;
const QUERY = `query($account: string!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    aiInferenceAdaptiveGroups(limit: 1, filter: {datetime_geq: $since, datetime_lt: $until}) {
      sum { totalNeurons }
    }
  } }
}`;

/** Account-wide usage, including other apps. No source code or prompts leave the machine here. */
export async function getCloudflareUsage(
  auto: DecisionConfig['automatic'], meter: DecisionCache | null, timeoutMs = 500,
): Promise<CloudflareUsage> {
  const checkedAt = Date.now();
  const day = new Date(checkedAt).toISOString().slice(0, 10);
  const unknown = (reason: string): CloudflareUsage => ({ status: 'unknown', day, checkedAt, usedNeurons: null, remainingNeurons: null, reason });
  if (!auto?.account || !auto.cfKey) return unknown('missing_credentials');
  if (!meter) return unknown('quota_store_unavailable');
  const tokenHash = createHash('sha256').update(auto.cfKey).digest('hex');
  try {
    const cached = meter.getCloudflareUsage(auto.account, tokenHash, day);
    if (cached && checkedAt >= cached.checkedAt && checkedAt - cached.checkedAt < CF_USAGE_TTL_MS) return cached;
    if (timeoutMs <= 0) return unknown('deadline');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let usage: CloudflareUsage;
    try {
      const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${auto.cfKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { account: auto.account, since: `${day}T00:00:00Z`, until: new Date(checkedAt).toISOString() } }),
        signal: controller.signal,
      });
      if (!response.ok) {
        usage = unknown(`http_${response.status}`);
      } else {
        const body = await response.json() as {
          errors?: unknown;
          data?: { viewer?: { accounts?: Array<{ aiInferenceAdaptiveGroups?: Array<{ sum?: { totalNeurons?: unknown } }> }> } };
        } | null;
        const accounts = body?.data?.viewer?.accounts;
        const groups = accounts?.[0]?.aiInferenceAdaptiveGroups;
        const used = groups?.length === 0 ? 0 : groups?.[0]?.sum?.totalNeurons;
        if (body?.errors != null && (!Array.isArray(body.errors) || body.errors.length > 0)) {
          usage = unknown('api_error');
        } else if (!Array.isArray(accounts) || accounts.length !== 1 || !Array.isArray(groups) || groups.length > 1
          || typeof used !== 'number' || !Number.isFinite(used) || used < 0) {
          usage = unknown('invalid_response');
        } else {
          const remaining = Math.max(0, CF_DAILY_FREE_NEURONS - used);
          usage = { status: remaining > 0 ? 'free' : 'exhausted', day, checkedAt, usedNeurons: used, remainingNeurons: remaining };
        }
      }
    } catch {
      usage = unknown(controller.signal.aborted ? 'timeout' : 'network_error');
    } finally {
      clearTimeout(timer);
    }
    if (new Date().toISOString().slice(0, 10) !== day) return unknown('day_changed');
    meter.putCloudflareUsage(auto.account, tokenHash, usage);
    return usage;
  } catch {
    return unknown('quota_store_unavailable');
  }
}
