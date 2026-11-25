/**
 * The one page the worker renders itself.
 *
 * It is inline rather than a static asset because it is the only thing served
 * without a session — keeping it here means the asset directory can stay
 * entirely behind the gate, with no "is this file public?" judgement calls.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LoginPageOptions {
  /** Path to return to after a successful sign-in. Already validated same-origin. */
  next: string;
  /** Shown above the form when a previous attempt failed. */
  error?: string;
  /** CSP nonce for the inline stylesheet. */
  nonce: string;
}

export function renderLoginPage({ next, error, nonce }: LoginPageOptions): string {
  const errorBlock = error ? `\n      <p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in — codegraph telemetry</title>
    <style nonce="${nonce}">
      :root {
        --paper: #f7f6f2;
        --ink: #16150f;
        --oxblood: #7a201a;
        --rule: #d8d5cb;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--paper);
        color: var(--ink);
        font-family: 'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 16px;
        line-height: 1.5;
      }
      main { width: 100%; max-width: 380px; }
      h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; }
      .subtitle { margin: 0 0 24px; color: #56534a; }
      hr { border: 0; border-top: 1px solid var(--rule); margin: 0 0 24px; }
      label { display: block; margin-bottom: 6px; }
      input[type='password'] {
        width: 100%;
        padding: 9px 10px;
        font: inherit;
        color: var(--ink);
        background: #fff;
        border: 1px solid var(--rule);
        border-radius: 0;
      }
      input[type='password']:focus {
        outline: 2px solid var(--oxblood);
        outline-offset: -2px;
        border-color: var(--oxblood);
      }
      button {
        margin-top: 16px;
        width: 100%;
        padding: 10px 12px;
        font: inherit;
        color: var(--paper);
        background: var(--oxblood);
        border: 1px solid var(--oxblood);
        border-radius: 0;
        cursor: pointer;
      }
      button:hover { background: #5f1914; border-color: #5f1914; }
      .error {
        margin: 0 0 16px;
        padding: 9px 10px;
        color: var(--oxblood);
        background: #fff;
        border: 1px solid var(--oxblood);
      }
      .footnote { margin: 24px 0 0; color: #56534a; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <h1>codegraph telemetry</h1>
      <p class="subtitle">This dashboard is private. Enter the shared password to continue.</p>
      <hr />${errorBlock}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <label for="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          autofocus
        />
        <button type="submit">Sign in</button>
      </form>
      <p class="footnote">You stay signed in on this browser for a year.</p>
    </main>
  </body>
</html>
`;
}
