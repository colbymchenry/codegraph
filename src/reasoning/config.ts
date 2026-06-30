/**
 * Reasoning-offload configuration: the persistent, machine-level settings the
 * `codegraph offload` CLI writes, merged with `CODEGRAPH_OFFLOAD_*` env overrides.
 *
 * Stored in `~/.codegraph/config.json` under the `offload` key — the same global
 * home CodeGraph already uses for the daemon registry — because the reasoning
 * endpoint is a per-machine choice (the model you bring), not per-project state.
 * Every codegraph MCP server on the machine picks it up, so a user configures it
 * once. Env vars override the file (CI / ephemeral / advanced use).
 *
 * For a BYO endpoint, the API key is NEVER written to disk: the CLI stores the
 * NAME of an env var (`keyEnv`) and reads the key from it at call time. The
 * MANAGED tier ("CodeGraph AI") instead authenticates with a revocable, org-scoped
 * token from `codegraph offload login`, stored separately in `credentials.json`
 * (see ./credentials) — so `config.json` itself never carries a secret either way.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readOffloadToken } from './credentials';

/** Managed tier ("CodeGraph AI") — the metered gateway used when logged in. */
export const MANAGED_DEFAULT_URL = 'https://ai.getcodegraph.com/v1';
/** The gateway's public model id (it translates this to the upstream provider id). */
export const MANAGED_DEFAULT_MODEL = 'openai/gpt-oss-120b';

export interface OffloadConfig {
  /** Managed tier: route through CodeGraph AI (metered) with the logged-in org token. */
  managed?: boolean;
  /** OpenAI-compatible base URL ending in `/v1` (e.g. https://api.cerebras.ai/v1). */
  url?: string;
  /** Model id to request (default `gpt-oss-120b` BYO, `openai/gpt-oss-120b` managed). */
  model?: string;
  /** Name of the env var holding the provider API key (never persisted). BYO only. */
  keyEnv?: string;
  /** Ordered provider fallback chain. Each entry is tried before falling back to local source. */
  providers?: OffloadProviderConfig[];
  /** reasoning_effort: low | medium | high (default `low`). */
  effort?: string;
  /** Output style: plain | report (default `plain`). */
  style?: string;
}

export interface OffloadProviderConfig {
  /** Human-readable label for debug/status and usage attribution. */
  name?: string;
  /** Managed tier: route through CodeGraph AI (metered) with the logged-in org token. */
  managed?: boolean;
  /** OpenAI-compatible base URL ending in `/v1`. */
  url?: string;
  /** Model id to request for this provider. */
  model?: string;
  /** Name of the env var holding this provider's API key (never persisted). */
  keyEnv?: string;
  /** Direct key override, accepted only from CODEGRAPH_OFFLOAD_PROVIDERS env JSON. */
  key?: string;
}

export interface ResolvedOffloadProvider {
  /** Human-readable label for debug/status and usage attribution. */
  name?: string;
  /** Managed tier (CodeGraph AI, metered) vs BYO endpoint. */
  managed: boolean;
  url: string;
  model: string;
  /** Resolved API key / org token, if any. */
  apiKey?: string;
  /** Where the key/token came from — never the secret itself. */
  keySource?: string;
}

export interface ResolvedOffload {
  /** True when the offload is usable (endpoint present; for managed, a token too). */
  enabled: boolean;
  /** Managed tier (CodeGraph AI, metered) vs BYO endpoint. */
  managed: boolean;
  /** Ordered provider fallback chain. First item mirrors the legacy top-level fields below. */
  providers: ResolvedOffloadProvider[];
  url?: string;
  model: string;
  /** Resolved API key / org token (from env, the configured `keyEnv`, or login), if any. */
  apiKey?: string;
  /** Where the key/token came from (for `status` display) — never the secret itself. */
  keySource?: string;
  effort: string;
  style: string;
  timeoutMs: number;
  maxTokens: number;
  strip: boolean;
  debug: boolean;
  /** Where the endpoint came from — drives `codegraph offload status`. */
  origin: 'env' | 'config' | 'none';
}

function configDir(): string {
  return path.join(os.homedir(), '.codegraph');
}
function configPath(): string {
  return path.join(configDir(), 'config.json');
}

function readUserConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeUserConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

/** The persisted offload block (empty object if none). */
export function readOffloadConfig(): OffloadConfig {
  const cfg = readUserConfig();
  const o = cfg.offload;
  return o && typeof o === 'object' ? (o as OffloadConfig) : {};
}

/** Persist (or, with `null`, clear) the offload block, leaving other config keys intact. */
export function writeOffloadConfig(offload: OffloadConfig | null): void {
  const cfg = readUserConfig();
  if (offload === null) delete cfg.offload;
  else cfg.offload = offload;
  writeUserConfig(cfg);
}

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

function parseProviderChain(raw: string | undefined): OffloadProviderConfig[] | undefined {
  const t = trimmed(raw);
  if (!t) return undefined;
  try {
    const parsed = JSON.parse(t) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p) => ({
        name: typeof p.name === 'string' ? p.name : undefined,
        managed: !!p.managed,
        url: typeof p.url === 'string' ? p.url : undefined,
        model: typeof p.model === 'string' ? p.model : undefined,
        keyEnv: typeof p.keyEnv === 'string' ? p.keyEnv : undefined,
        key: typeof p.key === 'string' ? p.key : undefined,
      }));
  } catch {
    return [];
  }
}

function resolveProvider(
  provider: OffloadProviderConfig,
  env: NodeJS.ProcessEnv,
  defaults: { url?: string; model: string; managed: boolean } = { model: 'gpt-oss-120b', managed: false }
): ResolvedOffloadProvider | null {
  const managed = !!provider.managed;
  const url = trimmed(provider.url) ?? (managed ? MANAGED_DEFAULT_URL : defaults.url);
  const model = trimmed(provider.model) ?? (managed ? MANAGED_DEFAULT_MODEL : defaults.model);
  let apiKey: string | undefined;
  let keySource: string | undefined;

  if (provider.key) {
    apiKey = trimmed(provider.key);
    keySource = 'CODEGRAPH_OFFLOAD_PROVIDERS';
  } else if (provider.keyEnv && trimmed(env[provider.keyEnv])) {
    apiKey = trimmed(env[provider.keyEnv]);
    keySource = provider.keyEnv;
  } else if (managed) {
    const t = readOffloadToken();
    if (t) { apiKey = t; keySource = 'codegraph login'; }
  }

  if (!url) return null;
  if (managed && !apiKey) return null;
  return { name: trimmed(provider.name), managed, url, model, apiKey, keySource };
}

/** Merge the persisted config with `CODEGRAPH_OFFLOAD_*` env overrides (env wins). */
export function resolveOffload(env: NodeJS.ProcessEnv = process.env): ResolvedOffload {
  // Hard kill-switch: disable the offload for this process/session without touching
  // the persisted config or the stored login — e.g. one A/B arm, or a user who wants
  // codegraph_explore to return raw source for a session. Env-only by design.
  if (env.CODEGRAPH_OFFLOAD_DISABLE === '1') {
    return {
      enabled: false, managed: false, providers: [], url: undefined, model: MANAGED_DEFAULT_MODEL,
      apiKey: undefined, keySource: undefined, effort: 'low', style: 'plain',
      timeoutMs: 20000, maxTokens: 12000, strip: false,
      debug: env.CODEGRAPH_OFFLOAD_DEBUG === '1', origin: 'none',
    };
  }
  const c = readOffloadConfig();
  const managed = !!c.managed;
  const envUrl = trimmed(env.CODEGRAPH_OFFLOAD_URL);
  const envKey = trimmed(env.CODEGRAPH_OFFLOAD_KEY);
  const envProviders = parseProviderChain(env.CODEGRAPH_OFFLOAD_PROVIDERS);

  let url: string | undefined;
  let apiKey: string | undefined;
  let keySource: string | undefined;
  let model: string;
  let providers: ResolvedOffloadProvider[] = [];

  if (managed) {
    // Managed tier: default to the CodeGraph AI gateway + its public model id; the
    // bearer is the org token from `codegraph offload login` (or an env override).
    url = envUrl ?? trimmed(c.url) ?? MANAGED_DEFAULT_URL;
    model = trimmed(env.CODEGRAPH_OFFLOAD_MODEL) ?? trimmed(c.model) ?? MANAGED_DEFAULT_MODEL;
    if (envKey) { apiKey = envKey; keySource = 'CODEGRAPH_OFFLOAD_KEY'; }
    else { const t = readOffloadToken(); if (t) { apiKey = t; keySource = 'codegraph login'; } }
  } else {
    // BYO: endpoint + (optional) provider key resolved from env or the named env var.
    url = envUrl ?? trimmed(c.url);
    model = trimmed(env.CODEGRAPH_OFFLOAD_MODEL) ?? trimmed(c.model) ?? 'gpt-oss-120b';
    if (envKey) { apiKey = envKey; keySource = 'CODEGRAPH_OFFLOAD_KEY'; }
    else if (c.keyEnv && trimmed(env[c.keyEnv])) { apiKey = trimmed(env[c.keyEnv]); keySource = c.keyEnv; }
  }

  if (envProviders !== undefined) {
    providers = envProviders
      .map((p) => resolveProvider(p, env, { url, model, managed: false }))
      .filter((p): p is ResolvedOffloadProvider => !!p);
  } else if (!envUrl && !envKey && Array.isArray(c.providers) && c.providers.length > 0) {
    providers = c.providers
      .map((p) => resolveProvider(p, env, { url, model, managed }))
      .filter((p): p is ResolvedOffloadProvider => !!p);
  }

  if (providers.length === 0 && url && (!managed || apiKey)) {
    providers = [{ managed, url, model, apiKey, keySource }];
  }

  const primary = providers[0];
  const origin: ResolvedOffload['origin'] = envProviders !== undefined || envUrl ? 'env' : (managed || trimmed(c.url) || (c.providers?.length ?? 0) > 0) ? 'config' : 'none';

  return {
    // Managed needs both an endpoint AND a token (no token → effectively logged out);
    // BYO needs only an endpoint (some endpoints require no auth).
    enabled: providers.length > 0,
    managed: primary?.managed ?? managed,
    providers,
    url: primary?.url ?? url,
    model: primary?.model ?? model,
    apiKey: primary?.apiKey ?? apiKey,
    keySource: primary?.keySource ?? keySource,
    effort: trimmed(env.CODEGRAPH_OFFLOAD_EFFORT) ?? trimmed(c.effort) ?? 'low',
    style: trimmed(env.CODEGRAPH_OFFLOAD_STYLE) ?? trimmed(c.style) ?? 'plain',
    timeoutMs: Number(env.CODEGRAPH_OFFLOAD_TIMEOUT_MS) || 20000,
    maxTokens: Number(env.CODEGRAPH_OFFLOAD_MAXTOKENS) || 12000,
    strip: env.CODEGRAPH_OFFLOAD_STRIP === '1',
    debug: env.CODEGRAPH_OFFLOAD_DEBUG === '1',
    origin,
  };
}
