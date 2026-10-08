import type { Backend } from './types';
import { homedir } from 'os';
import { join } from 'path';
import { AUTO_POLICY } from './policy';

export interface DecisionConfig {
  backend: Backend;
  url: string;
  model: string;
  apiKey: string | undefined;
  points: ReadonlySet<string> | 'all';
  timeoutMs: number;
  queryTimeoutMs: number;
  floors: Readonly<Record<string, number>>;
  recordPath: string | undefined;
  recordMax: number;
  overridesPath: string | undefined;
  ledgerPath: string | undefined;
  cachePath: string | undefined;
  automatic?: {
    account: string;
    cfKey: string | undefined;
    quotaPath: string;
  };
}

const DEFAULT_FLOOR = 0.7;
const JEV_ENDPOINT = { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' };

/** Workers AI REST endpoint for a hosted Clef model; empty without an account id (the client then fails closed). */
function cloudflareEndpoint(env: NodeJS.ProcessEnv): { url: string; model: string } {
  const model = env.CF_MODEL || 'clef';
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  return { url: account ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}` : '', model };
}

let cached: DecisionConfig | null = null;

/** Decision settings from process.env. Everything is off unless a CODEGRAPH_DECISION* variable says otherwise. */
export function decisionConfig(): DecisionConfig {
  return (cached ??= readDecisionConfig(process.env));
}

export function readDecisionConfig(env: NodeJS.ProcessEnv): DecisionConfig {
  const raw = (env.CODEGRAPH_DECISIONS ?? '').trim().toLowerCase();
  const backend: Backend = raw === 'cf' || raw === 'jev' || raw === 'auto' ? raw : 'off';
  const listed = (env.CODEGRAPH_DECISION_POINTS ?? '').trim();
  const endpoint = backend === 'off' ? { url: '', model: '' } : backend === 'cf' ? cloudflareEndpoint(env) : JEV_ENDPOINT;
  const automatic = backend === 'auto' ? {
    account: env.CLOUDFLARE_ACCOUNT_ID || '', cfKey: env.CLOUDFLARE_API_TOKEN || undefined,
    quotaPath: env.CODEGRAPH_CF_USAGE_DB || join(homedir(), '.codegraph', 'decision-usage.sqlite'),
  } : undefined;
  return {
    backend,
    // Auto cannot send a provider's credential to a custom endpoint.
    url: backend === 'auto' ? endpoint.url : env.CODEGRAPH_DECISIONS_URL || endpoint.url,
    model: backend === 'auto' ? endpoint.model : env.CODEGRAPH_DECISIONS_MODEL || endpoint.model,
    // Each backend gets only its own credential: the Jev key never reaches Cloudflare, and vice versa.
    apiKey: backend === 'jev' || backend === 'auto' ? env.JEV_API_KEY || undefined : backend === 'cf' ? env.CLOUDFLARE_API_TOKEN || undefined : undefined,
    points: listed === 'all' ? 'all' : new Set((listed || (automatic ? Object.keys(AUTO_POLICY).join(',') : '')).split(',').map((s) => s.trim()).filter(Boolean)),
    timeoutMs: positiveInt(env.CODEGRAPH_DECISIONS_TIMEOUT_MS, 30_000),
    queryTimeoutMs: positiveInt(env.CODEGRAPH_DECISIONS_QUERY_TIMEOUT_MS, 1_500),
    floors: parseFloors(env.CODEGRAPH_DECISION_FLOORS),
    recordPath: env.CODEGRAPH_DECISION_RECORD || undefined,
    recordMax: positiveInt(env.CODEGRAPH_DECISION_RECORD_MAX, 20_000),
    overridesPath: env.CODEGRAPH_DECISION_OVERRIDES || undefined,
    ledgerPath: env.CODEGRAPH_DECISION_LEDGER || undefined,
    cachePath: env.CODEGRAPH_DECISION_CACHE || automatic?.quotaPath,
    automatic,
  };
}

export function pointEnabled(cfg: DecisionConfig, point: string): boolean {
  if (cfg.backend === 'auto' && !Object.hasOwn(AUTO_POLICY, point)) return false;
  return cfg.points === 'all' || cfg.points.has(point);
}

export function floorFor(cfg: DecisionConfig, point: string): number {
  return cfg.floors[point] ?? (cfg.backend === 'auto' ? AUTO_POLICY[point]?.floor : undefined) ?? DEFAULT_FLOOR;
}

/** Tests change env vars between cases; drop the cached config so the next read follows. */
export function resetDecisionConfig(): void {
  cached = null;
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseFloors(v: string | undefined): Record<string, number> {
  if (!v) return {};
  try {
    const obj = JSON.parse(v) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(obj).filter(([, x]) => typeof x === 'number' && x >= 0 && x <= 1)) as Record<string, number>;
  } catch {
    return {};
  }
}
