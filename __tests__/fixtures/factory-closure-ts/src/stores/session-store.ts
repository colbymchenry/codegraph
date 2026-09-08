import type { StoreDeps } from './types';
import { joinPath, toQueryString } from '../lib/http';

/**
 * The session store — a factory closure and NOTHING else at file scope. No
 * companion type alias, no tail helper, no exported constants: every other
 * symbol in this file lives inside the closure. That shape matters, because it
 * is the one where the enclosing range is the only top-importance symbol the
 * file can offer a query.
 */
export function createSessionStore(deps: StoreDeps, baseUrl: string) {
  const SESSION_ENDPOINT = '/api/session';
  const REFRESH_SKEW_MS = 30_000;

  let token: string | null = null;
  let expiresAt = 0;
  let profile: { id: string; email: string; roles: string[] } | null = null;
  let refreshing: Promise<string | null> | null = null;
  const auditLog: Array<{ at: number; event: string }> = [];

  function record(event: string): void {
    auditLog.push({ at: deps.now(), event });
    if (auditLog.length > 200) auditLog.splice(0, auditLog.length - 200);
  }

  /** Exchange credentials for a session token and cache the profile. */
  async function signIn(email: string, password: string): Promise<boolean> {
    const url = joinPath(baseUrl, SESSION_ENDPOINT) + toQueryString({ email });
    let payload: unknown;
    try {
      payload = await deps.fetchJson(url);
    } catch (error) {
      record(`signIn failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (typeof payload !== 'object' || payload === null) {
      record('signIn got a non-object payload');
      return false;
    }
    const body = payload as { token?: string; expiresAt?: number; profile?: typeof profile };
    if (typeof body.token !== 'string' || body.token.length === 0) {
      record('signIn payload carried no token');
      return false;
    }
    void password;
    token = body.token;
    expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : deps.now() + 3_600_000;
    profile = body.profile ?? null;
    record(`signIn ok for ${email}`);
    return true;
  }

  /** Drop every trace of the session, locally and on the server. */
  async function signOut(): Promise<void> {
    if (token === null) return;
    const url = joinPath(baseUrl, SESSION_ENDPOINT) + toQueryString({ action: 'revoke' });
    try {
      await deps.fetchJson(url);
    } catch (error) {
      record(`signOut revoke failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    token = null;
    expiresAt = 0;
    profile = null;
    refreshing = null;
    record('signOut complete');
  }

  /**
   * Renew the token before it expires. Concurrent callers share one in-flight
   * request so a burst of requests cannot start a refresh storm.
   */
  async function refreshToken(): Promise<string | null> {
    if (token === null) return null;
    if (refreshing !== null) return refreshing;

    refreshing = (async () => {
      const url = joinPath(baseUrl, SESSION_ENDPOINT) + toQueryString({ action: 'refresh' });
      try {
        const payload = await deps.fetchJson(url);
        const body = payload as { token?: string; expiresAt?: number };
        if (typeof body?.token === 'string' && body.token.length > 0) {
          token = body.token;
          expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : deps.now() + 3_600_000;
          record('refreshToken renewed the session');
          return token;
        }
        record('refreshToken payload carried no token');
        return null;
      } catch (error) {
        record(`refreshToken failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        refreshing = null;
      }
    })();

    return refreshing;
  }

  /** The token to send with a request, renewing it first when it is close to expiry. */
  async function authorize(): Promise<string | null> {
    if (token === null) return null;
    if (deps.now() + REFRESH_SKEW_MS < expiresAt) return token;
    return refreshToken();
  }

  /** Does the signed-in user hold every one of these roles? */
  function hasRoles(...required: string[]): boolean {
    if (profile === null) return false;
    const held = new Set(profile.roles);
    for (const role of required) {
      if (!held.has(role)) return false;
    }
    return true;
  }

  /** Seconds left on the session, floored at zero. */
  function secondsRemaining(): number {
    if (token === null) return 0;
    return Math.max(0, Math.floor((expiresAt - deps.now()) / 1000));
  }

  /** The last N audit entries, newest first — what the account page renders. */
  function recentActivity(limit = 20): Array<{ at: number; event: string }> {
    return auditLog.slice(-limit).reverse();
  }

  function snapshot() {
    return {
      signedIn: token !== null,
      email: profile?.email ?? null,
      roles: profile?.roles ?? [],
      secondsRemaining: secondsRemaining(),
    };
  }

  return {
    signIn,
    signOut,
    refreshToken,
    authorize,
    hasRoles,
    secondsRemaining,
    recentActivity,
    snapshot,
  };
}
