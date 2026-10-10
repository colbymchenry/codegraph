import { readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { DecisionCache, decisionKey } from './cache';
import { askSystemOne } from './client';
import { decisionConfig, floorFor, pointEnabled } from './config';
import { writeLedger, type LedgerEntry } from './ledger';
import { POINTS } from './questions';
import { AUTO_POLICY, CF_DAILY_FREE_NEURONS, CF_INPUT_LIMIT, CF_NEURONS_PER_M } from './policy';
import { getCloudflareUsage } from './cloudflare-usage';
import type { BuildContext, DecisionRecord, Verdict } from './types';

let cache: DecisionCache | null | undefined;
let quota: DecisionCache | null | undefined;

function getCache(): DecisionCache | null {
  if (cache === undefined) {
    const path = decisionConfig().cachePath;
    try {
      cache = path ? new DecisionCache(path) : null;
    } catch {
      cache = null;
    }
  }
  return cache;
}

function getQuota(): DecisionCache | null {
  if (quota === undefined) {
    const path = decisionConfig().automatic?.quotaPath;
    try { quota = path ? new DecisionCache(path) : null; } catch { quota = null; }
  }
  return quota;
}

/** True when live decisions are on for this point (a backend is set AND the point is listed). */
export function isLive(point: string): boolean {
  const cfg = decisionConfig();
  return cfg.backend !== 'off' && pointEnabled(cfg, point);
}

/** Line access for question building, rooted at the project. */
export function fileContext(root: string): BuildContext {
  const files = new Map<string, string[]>();
  return {
    readLines(filePath, start, end) {
      const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
      let lines = files.get(abs);
      if (!lines) {
        try {
          lines = readFileSync(abs, 'utf-8').split(/\r?\n/);
        } catch {
          lines = [];
        }
        files.set(abs, lines);
      }
      return lines.slice(Math.max(0, start - 1), Math.max(0, end));
    },
  };
}

/**
 * Ask the configured model about one decision instance. Returns null — and the
 * caller keeps its heuristic — when off, not askable, failed, timed out, or
 * below the point's floor. Never throws. Every attempt is written to the ledger.
 */
export async function decideLive(rec: DecisionRecord, opts: { root: string; query?: boolean }): Promise<Verdict | null> {
  const entry = await decideWithLedger(rec, opts);
  return entry?.applied ? entry.verdict : null;
}

/** Same policy for live calls and offline index overrides, with the actual selected backend recorded. */
export async function decideWithLedger(rec: DecisionRecord, opts: { root: string; query?: boolean }): Promise<LedgerEntry | null> {
  try {
    if (!isLive(rec.point)) return null;
    const spec = POINTS[rec.point];
    const req = spec?.build(rec, fileContext(opts.root));
    if (!spec || !req) return null;
    const cfg = decisionConfig();
    const store = getCache();
    const targets = cfg.backend === 'auto' ? [] : [{ backend: cfg.backend, url: cfg.url, model: cfg.model, apiKey: cfg.apiKey }];
    const auto = cfg.automatic;
    const model = AUTO_POLICY[rec.point]?.cfModel;
    const deadline = Date.now() + (opts.query ? cfg.queryTimeoutMs : cfg.timeoutMs);
    const usage = auto && model ? await getCloudflareUsage(auto, getQuota(), Math.min(500, deadline - Date.now())) : undefined;
    if (auto) {
      if (model && usage?.status === 'free') {
        targets.push({ backend: 'cf', url: `https://api.cloudflare.com/client/v4/accounts/${auto.account}/ai/run/@cf/cloudflare/${model}`, model, apiKey: auto.cfKey });
      }
      if (cfg.apiKey) targets.push({ backend: 'jev', url: cfg.url, model: cfg.model, apiKey: cfg.apiKey });
    }
    let last: LedgerEntry | null = null;
    for (const target of targets) {
      // Use the actual backend/model, not "auto", so answers never mix across providers.
      const key = decisionKey(`${target.backend}/${target.model}`, req);
      let res = store?.get(key) ?? null;
      if (!res) {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) break;
        const rate = auto && target.backend === 'cf' && model ? CF_NEURONS_PER_M[model] : 0;
        const reserved = CF_INPUT_LIMIT * rate / 1e6;
        const meter = rate ? getQuota() : null;
        const day = new Date().toISOString().slice(0, 10);
        if (auto && rate && (usage?.day !== day || !meter?.reserveNeurons(auto.account, day, reserved, CF_DAILY_FREE_NEURONS))) continue;
        res = await askSystemOne(req, { ...target, timeoutMs });
        if (auto && rate && res && Number.isInteger(res.usage.inputTokens) && res.usage.inputTokens > 0) {
          meter?.settleNeurons(auto.account, day, reserved, res.usage.inputTokens * rate / 1e6);
        }
        if (res && store) store.put(key, res);
      }
      const raw = res ? spec.interpret(res, rec) : null;
      last = {
        ts: Date.now(), point: rec.point, key: rec.key, backend: target.backend, model: target.model,
        verdict: raw, applied: !!raw && raw.p >= floorFor(cfg, rec.point), heuristic: rec.heuristic.pick,
        latencyMs: res?.latencyMs ?? -1, cached: res?.cached ?? false, inputTokens: res?.usage.inputTokens ?? 0,
        ...(usage ? { cloudflare: usage } : {}),
      };
      writeLedger(last);
      if (last.applied) return last;
    }
    return last;
  } catch {
    return null;
  }
}

/** Inspect routing without sending a prompt or making an inference request. */
export async function decisionStatus() {
  const cfg = decisionConfig();
  if (!cfg.automatic) return { mode: cfg.backend };
  const meter = getQuota();
  const usage = await getCloudflareUsage(cfg.automatic, meter, 5_000);
  const available = usage.status === 'unknown' ? null
    : meter!.remainingNeurons(cfg.automatic.account, usage.day, CF_DAILY_FREE_NEURONS);
  const routes = Object.fromEntries(Object.entries(AUTO_POLICY).map(([point, { cfModel }]) => [point,
    !pointEnabled(cfg, point) || (point === 'D1' && process.env.CODEGRAPH_DECISION_ALLOW_REMOTE_PROMPTS !== '1') ? 'off'
      : cfModel && usage.status === 'free' && available! >= CF_INPUT_LIMIT * CF_NEURONS_PER_M[cfModel] / 1e6
        ? cfModel : cfg.apiKey ? 'jev' : 'off',
  ]));
  return { mode: cfg.backend, cloudflare: { ...usage, availableNeurons: available }, routes };
}

export function resetLive(): void {
  try {
    cache?.close();
  } catch {
    /* already closed */
  }
  cache = undefined;
  try { quota?.close(); } catch { /* already closed */ }
  quota = undefined;
}
