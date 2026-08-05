/**
 * Secrets are set with `wrangler secret put`, so they are deliberately absent from
 * wrangler.jsonc (this repo is public) and `wrangler types` cannot see them. Declared
 * here by interface merging so the worker type-checks with or without a local
 * `.dev.vars`. Anything listed here may be missing at runtime — check before use.
 */
interface Env {
  /** Shared secret for `POST /admin/rollup`. Unset ⇒ the route does not exist (404). */
  ADMIN_TOKEN: string;
}
