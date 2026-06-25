/**
 * Anonymous usage telemetry — client side.
 *
 * The contract for what may be collected lives in docs/design/telemetry.md
 * (and user-facing TELEMETRY.md); the ingest endpoint that enforces it is
 * public at telemetry-worker/. This module honors four invariants:
 *
 * 1. Zero hot-path cost: recording is an in-memory increment. Disk writes are
 *    a tiny synchronous append at process exit (works under `process.exit()`,
 *    where `beforeExit` never fires); network sends happen opportunistically
 *    (startup of long-running commands, daemon interval, bounded await at the
 *    end of install/init) and are fire-and-forget everywhere else.
 * 2. Zero stdout: stdio is the MCP protocol channel. Notices and debug output
 *    go to stderr only.
 * 3. Off is off: when disabled, nothing is recorded, nothing is sent, and no
 *    socket is opened — there is no "opted out" ping. Turning telemetry off
 *    also deletes any buffered, unsent data.
 * 4. Fail silent: offline, endpoint down, disk full — every failure mode is
 *    silence, never a retry loop, never an error surfaced to the user/agent.
 *
 * Usage counts aggregate locally into per-day rollups; only *completed* (UTC)
 * days are sent, so volume scales with active machines, not with tool calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

export const TELEMETRY_ENDPOINT = 'https://telemetry.getcodegraph.com/v1/events';
export const TELEMETRY_DOCS = 'https://github.com/colbymchenry/codegraph/blob/main/TELEMETRY.md';

// v2: dropped the `sqlite_backend` field from the `index` event — node:sqlite is
// now the only backend (the better-sqlite3-native / wasm-fallback split is gone),
// so the value was a constant carrying no signal. See TELEMETRY.md.
const SCHEMA_VERSION = 2;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_EVENTS_PER_REQUEST = 100;
const DEFAULT_FLUSH_TIMEOUT_MS = 1500;
/** A crashed sender's claimed file is merged back after this long. */
const STALE_CLAIM_MS = 60 * 60_000;

export type UsageKind = 'mcp_tool' | 'cli_command';
export type LifecycleEvent = 'install' | 'index' | 'uninstall';

/** Coarse buckets — exact counts are deliberately not collected. */
export function bucketFileCount(n: number): '<100' | '100-1k' | '1k-10k' | '10k+' {
  if (n < 100) return '<100';
  if (n < 1000) return '100-1k';
  if (n < 10000) return '1k-10k';
  return '10k+';
}

export function bucketDuration(ms: number): '<10s' | '10-60s' | '1-5m' | '5m+' {
  if (ms < 10_000) return '<10s';
  if (ms < 60_000) return '10-60s';
  if (ms < 300_000) return '1-5m';
  return '5m+';
}

/**
 * Shared "a full index completed" event (CLI init/index + installer local
 * init): language names and coarse buckets only — never paths, file names,
 * or exact counts. Structurally typed so callers don't need engine imports.
 */
export function recordIndexEvent(
  cg: { getStats(): { filesByLanguage: Record<string, number> } },
  result: { filesIndexed: number; durationMs: number },
): void {
  try {
    const languages = Object.entries(cg.getStats().filesByLanguage)
      .filter(([, count]) => count > 0)
      .map(([lang]) => lang);
    getTelemetry().recordLifecycle('index', {
      languages,
      file_count_bucket: bucketFileCount(result.filesIndexed),
      duration_bucket: bucketDuration(result.durationMs),
    });
  } catch {
    /* telemetry must never break indexing */
  }
}

export interface ClientInfo {
  name?: string;
  version?: string;
}

interface ConfigFile {
  enabled: boolean;
  machine_id: string;
  consent_source: 'installer' | 'default-notice' | 'cli';
  first_run_notice_shown?: boolean;
  updated_at: string;
}

export interface TelemetryStatus {
  enabled: boolean;
  /** What decided the current state — mirrors the precedence order. */
  decidedBy: 'DO_NOT_TRACK' | 'CODEGRAPH_TELEMETRY' | 'config' | 'default';
  machineId: string | null;
  configPath: string;
}

/** One buffered line: either a usage-count delta or a lifecycle event. */
interface CountLine {
  v: number;
  d: string; // UTC day YYYY-MM-DD
  k: UsageKind;
  n: string;
  c: number; // calls
  e: number; // errors
  cn?: string; // client name (mcp_tool only)
  cv?: string; // client version
}
interface EventLine {
  v: number;
  ev: LifecycleEvent;
  ts: string;
  props: Record<string, unknown>;
}
type BufferLine = CountLine | EventLine;

export interface TelemetryOptions {
  /** Global state dir; defaults to ~/.codegraph. Tests inject a temp dir. */
  dir?: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
  /** Tests opt out so short-lived instances don't pile onto process 'exit'. */
  installExitHook?: boolean;
}

// One process-level 'exit' listener for ALL instances (in practice: the
// singleton) — N instances must not mean N listeners on process.
const exitInstances = new Set<Telemetry>();
let exitListenerRegistered = false;
function registerForExit(instance: Telemetry): void {
  exitInstances.add(instance);
  if (!exitListenerRegistered) {
    exitListenerRegistered = true;
    // 'exit' fires under process.exit() too (unlike beforeExit); handlers must
    // be synchronous — persistSync is a single small file write.
    process.on('exit', () => {
      for (const i of exitInstances) i.persistSync();
    });
  }
}

export class Telemetry {
  private readonly dir: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly writeStderr: (line: string) => void;

  private counts = new Map<string, CountLine>();
  private events: EventLine[] = [];
  private readonly installExitHook: boolean;
  private exitHookInstalled = false;
  private configCache: ConfigFile | null | undefined; // undefined = not read yet
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(opts: TelemetryOptions = {}) {
    this.dir = opts.dir ?? path.join(os.homedir(), '.codegraph');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    this.env = opts.env ?? process.env;
    this.writeStderr = opts.stderr ?? ((line) => process.stderr.write(line));
    this.installExitHook = opts.installExitHook ?? true;
  }

  // ---------------------------------------------------------------- consent

  get configPath(): string {
    return path.join(this.dir, 'telemetry.json');
  }
  get queuePath(): string {
    return path.join(this.dir, 'telemetry-queue.jsonl');
  }

  /**
   * Resolution order (first match wins) — keep in sync with TELEMETRY.md:
   * DO_NOT_TRACK=1 > CODEGRAPH_TELEMETRY=0|1 > stored config > default on.
   */
  getStatus(): TelemetryStatus {
    const config = this.readConfig();
    const machineId = config?.machine_id ?? null;
    const dnt = this.env.DO_NOT_TRACK;
    if (dnt !== undefined && dnt !== '' && dnt !== '0' && dnt.toLowerCase() !== 'false') {
      return { enabled: false, decidedBy: 'DO_NOT_TRACK', machineId, configPath: this.configPath };
    }
    const forced = this.env.CODEGRAPH_TELEMETRY;
    if (forced !== undefined && forced !== '') {
      const on = forced !== '0' && forced.toLowerCase() !== 'false';
      return { enabled: on, decidedBy: 'CODEGRAPH_TELEMETRY', machineId, configPath: this.configPath };
    }
    if (config) {
      return { enabled: config.enabled, decidedBy: 'config', machineId, configPath: this.configPath };
    }
    return { enabled: true, decidedBy: 'default', machineId, configPath: this.configPath };
  }

  isEnabled(): boolean {
    return this.getStatus().enabled;
  }

  /**
   * Persist an explicit user choice (installer toggle or `codegraph
   * telemetry on|off`). Turning telemetry off also deletes any buffered,
   * unsent data — off means off.
   */
  setEnabled(enabled: boolean, source: 'installer' | 'cli'): void {
    const existing = this.readConfig();
    this.writeConfig({
      enabled,
      machine_id: existing?.machine_id ?? randomUUID(),
      consent_source: source,
      first_run_notice_shown: true,
      updated_at: this.now().toISOString(),
    });
    if (!enabled) {
      try { fs.rmSync(this.queuePath, { force: true }); } catch { /* fail silent */ }
    }
  }

  /** True once any consent decision (or the first-run notice) is on disk. */
  hasStoredChoice(): boolean {
    return this.readConfig() !== null;
  }

  // -------------------------------------------------------------- recording

  /** In-memory increment — safe on the MCP tool-call hot path. */
  recordUsage(kind: UsageKind, name: string, ok: boolean, client?: ClientInfo): void {
    if (!this.isEnabled()) return;
    const day = this.utcDay();
    const cn = client?.name?.slice(0, 64);
    const cv = client?.version?.slice(0, 32);
    const key = [day, kind, name, cn ?? '', cv ?? ''].join(' ');
    const line = this.counts.get(key);
    if (line) {
      line.c += 1;
      if (!ok) line.e += 1;
    } else {
      const fresh: CountLine = { v: SCHEMA_VERSION, d: day, k: kind, n: name.slice(0, 64), c: 1, e: ok ? 0 : 1 };
      if (cn) fresh.cn = cn;
      if (cv) fresh.cv = cv;
      this.counts.set(key, fresh);
    }
    this.ensureExitHook();
  }

  /** install / index / uninstall — buffered like everything else. */
  recordLifecycle(event: LifecycleEvent, props: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    this.events.push({ v: SCHEMA_VERSION, ev: event, ts: this.now().toISOString(), props });
    this.ensureExitHook();
  }

  // ---------------------------------------------------------------- sending

  /**
   * Fire-and-forget send of everything sendable. Never throws, never logs
   * above debug. Safe to call at startup of long-running commands.
   */
  maybeFlush(): void {
    void this.flushNow().catch(() => { /* fail silent */ });
  }

  /**
   * Drain in-memory state to the buffer, then send completed-day rollups and
   * lifecycle events. Bounded by `timeoutMs`; leftovers stay buffered for the
   * next process. Awaited only where latency is invisible (install/init).
   */
  async flushNow(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      this.persistSync();
      this.recoverStaleClaims();
      const claim = this.claimQueue();
      if (!claim) return;
      const { claimPath, lines } = claim;
      const today = this.utcDay();
      const sendable: BufferLine[] = [];
      const keep: BufferLine[] = [];
      for (const line of lines) {
        if ('ev' in line) sendable.push(line);
        else if (line.d < today) sendable.push(line);
        else keep.push(line);
      }
      let failed: BufferLine[] = [];
      if (sendable.length > 0) {
        // Consent gate: the one-time notice precedes the FIRST bytes that
        // ever leave the machine (and mints the machine id). Recording only
        // buffers locally, so it stays silent — this lets the installer show
        // its explicit consent toggle before any notice can fire, instead of
        // the preAction usage count pre-empting it. An explicit installer/CLI
        // choice sets first_run_notice_shown and suppresses this permanently.
        this.firstRunNotice();
        failed = await this.send(sendable, timeoutMs);
      }
      // Whatever didn't go out returns to the queue (append — writers may
      // have created a fresh queue file while we held the claim).
      const back = [...failed, ...keep];
      if (back.length > 0) this.appendLines(back);
      try { fs.rmSync(claimPath, { force: true }); } catch { /* fail silent */ }
    } catch {
      /* fail silent */
    }
  }

  /**
   * Periodic flush for long-lived processes (MCP daemon / serve). Unref'd so
   * it never keeps the process alive.
   */
  startInterval(everyMs: number = 6 * 60 * 60_000): void {
    if (this.intervalHandle || !this.isEnabled()) return;
    this.maybeFlush();
    this.intervalHandle = setInterval(() => this.maybeFlush(), everyMs);
    this.intervalHandle.unref();
  }

  stopInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // -------------------------------------------------------------- internals

  private utcDay(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private readConfig(): ConfigFile | null {
    if (this.configCache !== undefined) return this.configCache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as ConfigFile;
      this.configCache = typeof raw.machine_id === 'string' && typeof raw.enabled === 'boolean' ? raw : null;
    } catch {
      this.configCache = null;
    }
    return this.configCache;
  }

  private writeConfig(config: ConfigFile): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2) + '\n');
      this.configCache = config;
    } catch {
      /* fail silent */
    }
  }

  /**
   * Default-on consent is gated by a one-time stderr notice (interactive
   * installs record their choice explicitly and never reach this).
   */
  private firstRunNotice(): void {
    const config = this.readConfig();
    if (config?.first_run_notice_shown) return;
    if (!config) {
      this.writeConfig({
        enabled: true,
        machine_id: randomUUID(),
        consent_source: 'default-notice',
        first_run_notice_shown: true,
        updated_at: this.now().toISOString(),
      });
    } else {
      this.writeConfig({ ...config, first_run_notice_shown: true, updated_at: this.now().toISOString() });
    }
    this.writeStderr(
      `codegraph collects anonymous usage stats (no code, paths, or names) — ` +
      `"codegraph telemetry off" or CODEGRAPH_TELEMETRY=0 disables. Details: ${TELEMETRY_DOCS}\n`,
    );
  }

  /**
   * Synchronous, tiny, exit-safe: drain in-memory deltas to the JSONL queue.
   * Runs on `process.on('exit')`, so it must never be async or slow.
   */
  persistSync(): void {
    if (this.counts.size === 0 && this.events.length === 0) return;
    const lines: BufferLine[] = [...this.counts.values(), ...this.events];
    this.counts.clear();
    this.events = [];
    // Re-check at persist time: `codegraph telemetry off` mid-process must not
    // have its own invocation resurrect the queue file at exit.
    if (!this.isEnabled()) return;
    this.appendLines(lines);
  }

  private appendLines(lines: BufferLine[]): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const payload = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      // Cap the buffer: drop oldest lines first (telemetry is best-effort —
      // bounded disk use beats completeness).
      let existing = '';
      try { existing = fs.readFileSync(this.queuePath, 'utf8'); } catch { /* no queue yet */ }
      let combined = existing + payload;
      if (combined.length > MAX_BUFFER_BYTES) {
        combined = combined.slice(combined.length - MAX_BUFFER_BYTES);
        combined = combined.slice(combined.indexOf('\n') + 1); // drop the partial first line
      }
      fs.writeFileSync(this.queuePath, combined);
    } catch {
      /* fail silent */
    }
  }

  /**
   * Atomically claim the queue for sending (rename). Concurrent processes
   * can't double-send; a crash mid-send leaves a claim file that
   * `recoverStaleClaims` merges back after an hour.
   */
  private claimQueue(): { claimPath: string; lines: BufferLine[] } | null {
    const claimPath = path.join(this.dir, `telemetry-queue.sending.${process.pid}.jsonl`);
    try {
      fs.renameSync(this.queuePath, claimPath);
    } catch {
      return null; // no queue, or another process just claimed it
    }
    const lines: BufferLine[] = [];
    try {
      for (const raw of fs.readFileSync(claimPath, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        try {
          const parsed = JSON.parse(raw) as BufferLine;
          if (parsed && typeof parsed === 'object' && parsed.v === SCHEMA_VERSION) lines.push(parsed);
        } catch {
          /* skip corrupt line */
        }
      }
    } catch {
      /* unreadable claim — treat as empty; file removed by caller */
    }
    return { claimPath, lines };
  }

  private recoverStaleClaims(): void {
    try {
      const cutoff = this.now().getTime() - STALE_CLAIM_MS;
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.startsWith('telemetry-queue.sending.')) continue;
        const full = path.join(this.dir, name);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) {
            const content = fs.readFileSync(full, 'utf8');
            fs.rmSync(full, { force: true });
            if (content.trim()) fs.appendFileSync(this.queuePath, content.endsWith('\n') ? content : content + '\n');
          }
        } catch {
          /* fail silent */
        }
      }
    } catch {
      /* fail silent */
    }
  }

  /** Returns the lines that did NOT make it out (to be re-queued). */
  private async send(lines: BufferLine[], timeoutMs: number): Promise<BufferLine[]> {
    const config = this.readConfig();
    if (!config) return [];
    const events = lines.map((line) =>
      'ev' in line
        ? { event: line.ev, ts: line.ts, props: line.props }
        : {
            event: 'usage_rollup',
            ts: `${line.d}T12:00:00.000Z`,
            props: {
              kind: line.k,
              name: line.n,
              count: line.c,
              error_count: line.e,
              ...(line.cn ? { client_name: line.cn } : {}),
              ...(line.cv ? { client_version: line.cv } : {}),
            },
          },
    );
    const envelope = {
      machine_id: config.machine_id,
      codegraph_version: this.packageVersion(),
      os: process.platform,
      arch: process.arch,
      node_major: parseInt(process.versions.node.split('.')[0] ?? '0', 10),
      ci: this.env.CI !== undefined && this.env.CI !== '' && this.env.CI !== '0' && this.env.CI !== 'false',
      schema_version: SCHEMA_VERSION,
    };
    const endpoint = this.env.CODEGRAPH_TELEMETRY_ENDPOINT || TELEMETRY_ENDPOINT;
    for (let i = 0; i < events.length; i += MAX_EVENTS_PER_REQUEST) {
      const chunk = events.slice(i, i + MAX_EVENTS_PER_REQUEST);
      const body = JSON.stringify({ ...envelope, events: chunk });
      this.debug(`POST ${endpoint} (${chunk.length} events)`);
      try {
        // Any response — 204, 4xx, anything — is final. No retries.
        await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        this.debug(`send failed: ${String(err)}`);
        return lines.slice(i); // network failure: re-queue this chunk + the rest
      }
    }
    return [];
  }

  private packageVersion(): string {
    try {
      // dist/telemetry/index.js → ../../package.json (same layout in src/ for tests via tsx)
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
      return pkg.version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  private ensureExitHook(): void {
    if (this.exitHookInstalled || !this.installExitHook) return;
    this.exitHookInstalled = true;
    registerForExit(this);
  }

  private debug(msg: string): void {
    if (this.env.CODEGRAPH_TELEMETRY_DEBUG === '1') {
      this.writeStderr(`[codegraph telemetry] ${msg}\n`);
    }
  }
}

// Process-wide singleton — app code goes through this; tests construct their own.
let singleton: Telemetry | null = null;

export function getTelemetry(): Telemetry {
  if (!singleton) singleton = new Telemetry();
  return singleton;
}
