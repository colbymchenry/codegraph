import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { createDatabase, type SqliteDatabase } from '../db/sqlite-adapter';
import type { DecisionRequest, DecisionResponse } from './types';
import type { CloudflareUsage } from './cloudflare-usage';

/** Content address of one request to one model: same model + state + questions → same key. */
export function decisionKey(model: string, req: DecisionRequest): string {
  // Older entries may contain null probabilities coerced to zero before validation.
  return createHash('sha256').update('validated-v2\n').update(model).update('\n').update(stableJson(req.state)).update('\n').update(stableJson(req.questions)).digest('hex');
}

/** JSON with sorted object keys, so equal values hash equally. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

/** Persistent answer cache: re-running an evaluation or a re-index asks each question once. */
export class DecisionCache {
  private readonly db: SqliteDatabase;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = createDatabase(path).db;
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS decisions (key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS cf_usage (account TEXT NOT NULL, day TEXT NOT NULL, neurons REAL NOT NULL, PRIMARY KEY (account, day))');
    // Old reservations remain counted as spent when upgrading the local ledger.
    this.db.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(cf_usage)').all().some(row => row.name === 'pending')) {
        this.db.exec('ALTER TABLE cf_usage ADD COLUMN pending REAL NOT NULL DEFAULT 0');
      }
    })();
    this.db.exec(`CREATE TABLE IF NOT EXISTS cf_analytics (
      account TEXT NOT NULL, token_hash TEXT NOT NULL, day TEXT NOT NULL,
      checked_at INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY (account, token_hash, day))`);
  }

  get(key: string): DecisionResponse | null {
    const row = this.db.prepare('SELECT response FROM decisions WHERE key = ?').get(key) as { response: string } | undefined;
    return row ? { ...(JSON.parse(row.response) as DecisionResponse), cached: true } : null;
  }

  put(key: string, res: DecisionResponse): void {
    this.db.prepare('INSERT OR REPLACE INTO decisions (key, response, created_at) VALUES (?, ?, ?)').run(key, JSON.stringify({ ...res, cached: false }), Date.now());
  }

  /** One atomic statement: concurrent processes share reservations before making requests. */
  reserveNeurons(account: string, day: string, neurons: number, cap: number): boolean {
    if (![neurons, cap].every(Number.isFinite) || neurons <= 0 || cap < neurons || cap > 10_000) return false;
    return this.db.prepare(`INSERT INTO cf_usage (account, day, neurons, pending) VALUES (?, ?, 0, ?)
      ON CONFLICT(account, day) DO UPDATE SET pending = cf_usage.pending + excluded.pending
      WHERE cf_usage.neurons + cf_usage.pending + excluded.pending <= ?`).run(account, day, neurons, cap).changes === 1;
  }

  /** A missing/malformed usage report cannot refund the worst-case reservation. */
  settleNeurons(account: string, day: string, reserved: number, charged: number): void {
    if (![reserved, charged].every(Number.isFinite) || charged < 0 || charged > reserved) return;
    this.db.prepare(`UPDATE cf_usage SET neurons = neurons + ?, pending = pending - ?
      WHERE account = ? AND day = ? AND pending >= ?`).run(charged, reserved, account, day, reserved);
  }

  remainingNeurons(account: string, day: string, cap: number): number {
    const row = this.db.prepare('SELECT neurons + pending AS used FROM cf_usage WHERE account = ? AND day = ?')
      .get(account, day) as { used: number } | undefined;
    return Math.max(0, cap - (row?.used ?? 0));
  }

  getCloudflareUsage(account: string, tokenHash: string, day: string): CloudflareUsage | null {
    const row = this.db.prepare('SELECT snapshot FROM cf_analytics WHERE account = ? AND token_hash = ? AND day = ?')
      .get(account, tokenHash, day) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as CloudflareUsage : null;
  }

  putCloudflareUsage(account: string, tokenHash: string, usage: CloudflareUsage): void {
    this.db.transaction(() => {
      if (usage.usedNeurons !== null && Number.isFinite(usage.usedNeurons) && usage.usedNeurons >= 0) {
        // Analytics can include a request before its response arrives. Never erase in-flight reservations.
        this.db.prepare(`INSERT INTO cf_usage (account, day, neurons) VALUES (?, ?, ?)
          ON CONFLICT(account, day) DO UPDATE SET neurons = MAX(cf_usage.neurons, excluded.neurons)`)
          .run(account, usage.day, usage.usedNeurons);
      }
      this.db.prepare(`INSERT INTO cf_analytics VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account, token_hash, day) DO UPDATE SET checked_at = excluded.checked_at, snapshot = excluded.snapshot
        WHERE excluded.checked_at >= cf_analytics.checked_at`)
        .run(account, tokenHash, usage.day, usage.checkedAt, JSON.stringify(usage));
    })();
  }

  close(): void {
    this.db.close();
  }
}
