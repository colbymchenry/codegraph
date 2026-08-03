#!/usr/bin/env node
/**
 * Renders the dashboard in a real browser against the fixture and checks that
 * every panel drew, and drew the numbers the API returned.
 *
 * smoke-api.sh proves the SQL; this proves the other half — that each panel is
 * wired to the right endpoint and plots it without mangling it. It reads the
 * Chart.js instance off each canvas and compares its dataset arrays against the
 * same endpoint fetched straight from Node, so a panel pointed at the wrong dim
 * fails here even though both halves are individually fine.
 *
 *   node scripts/render-check.mjs        (or: npm run smoke:render)
 *
 * Zero new dependencies: it drives whatever Chromium is already on the machine
 * over the DevTools protocol (Node 22 has WebSocket built in). With no browser
 * installed it SKIPS rather than fails — the shell smoke suites stay the
 * portable floor, and this is the deeper check where a browser exists.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.DASH_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;

/** The fixture's own window — see scripts/fixture.sql. */
const FROM = '2026-07-01';
const TO = '2026-07-10';

let pass = 0;
let fail = 0;

const ok = (what) => {
  console.log(`  ok    ${what}`);
  pass++;
};
const bad = (what, detail) => {
  console.log(`  FAIL  ${what}${detail ? ` (${detail})` : ''}`);
  fail++;
};
const check = (what, condition, detail) => (condition ? ok(what) : bad(what, detail));
const same = (what, expected, actual) =>
  check(
    what,
    JSON.stringify(expected) === JSON.stringify(actual),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Finding a browser
// ---------------------------------------------------------------------------

/** Expands one `*` in a path segment, newest match first. */
function glob(pattern) {
  const [head, ...rest] = pattern.split('*');
  const base = dirname(head);
  const prefix = head.slice(base.length + 1);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .map((name) => join(base, name) + rest.join('*'));
}

function findBrowser() {
  const home = process.env.HOME ?? '';
  const candidates = [
    process.env.CHROME_BIN,
    ...glob(`${home}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell`),
    ...glob(`${home}/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-x64/chrome-headless-shell`),
    ...glob(`${home}/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux/chrome-headless-shell`),
    ...glob(`${home}/.cache/ms-playwright/chromium-*/chrome-linux/chrome`),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

// ---------------------------------------------------------------------------
// A minimal DevTools-protocol client
// ---------------------------------------------------------------------------

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      } else {
        this.events.push(message);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot reach ${url}`)), { once: true });
    });
    return new CDP(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  /** Runs an expression in the page and returns its value, awaiting promises. */
  async evaluate(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'page threw');
    }
    return result.result.value;
  }
}

// ---------------------------------------------------------------------------
// The page probe
// ---------------------------------------------------------------------------

/**
 * Runs inside the page. Reads what each panel actually rendered — including the
 * live Chart.js instance behind each canvas — rather than trusting that a
 * fetch resolved.
 */
const PROBE = `(() => {
  const panels = [...document.querySelectorAll('[data-panel]')].map((section) => {
    const canvas = section.querySelector('canvas');
    const chart = canvas && window.Chart ? window.Chart.getChart(canvas) : null;
    return {
      id: section.dataset.panel,
      state: section.dataset.state,
      stale: section.dataset.stale,
      title: section.querySelector('h2').textContent,
      figure: section.querySelector('[data-role="figure"]').textContent,
      note: section.querySelector('.panel-note')?.textContent ?? '',
      message: section.querySelector('[data-role="state"]').textContent,
      stat: section.querySelector('.stat-value')?.textContent ?? null,
      funnelValues: [...section.querySelectorAll('.funnel-value')].map((n) => n.textContent),
      funnelWidths: [...section.querySelectorAll('.funnel-fill')].map((n) => n.style.width),
      chart: chart && {
        type: chart.config.type,
        labels: chart.data.labels,
        datasets: chart.data.datasets.map((d) => ({ label: d.label, data: d.data })),
        legend: chart.options.plugins?.legend?.display !== false,
      },
      tableRows: section.querySelectorAll('[data-role="table"] tbody tr').length,
      tableCols: section.querySelectorAll('[data-role="table"] thead th').length,
      tableHidden: section.querySelector('[data-role="table"]').hidden,
    };
  });
  return {
    ready: document.body.dataset.ready === 'true',
    range: document.getElementById('range-summary').textContent,
    dataThrough: document.getElementById('data-through').textContent,
    refreshed: document.getElementById('refreshed-at').textContent,
    selectedPreset: document.querySelector('button.range.is-selected')?.textContent ?? null,
    panels,
  };
})()`;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const children = [];
let profileDir = null;

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'ignore', ...options });
  children.push(child);
  return child;
}

async function waitFor(what, probe, attempts = 90) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await probe()) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('render-check: no Chromium found — skipping.');
    console.log('  Set CHROME_BIN, or install Chrome; the shell smoke suites cover the rest.');
    return 0;
  }
  console.log(`Browser: ${browserPath}`);

  console.log('Seeding the local D1 fixture…');
  const seed = run('./scripts/seed-fixture.sh', [], { stdio: 'inherit' });
  const seeded = await new Promise((resolve) => seed.on('exit', resolve));
  if (seeded !== 0) throw new Error('seeding failed');

  console.log(`Starting wrangler dev on :${PORT}…`);
  run('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1']);
  await waitFor('wrangler dev', async () => (await fetch(`${BASE}/robots.txt`)).ok);

  const password = readFileSync(join(root, '.dev.vars'), 'utf8').match(/^ADMIN_PASSWORD="(.*)"$/m)?.[1];
  if (!password) throw new Error('no ADMIN_PASSWORD in .dev.vars');
  const login = await fetch(`${BASE}/login`, {
    method: 'POST',
    body: new URLSearchParams({ password }),
    redirect: 'manual',
  });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('cg_admin_session='));
  if (!cookie) throw new Error('login did not set a session cookie');
  const [name, value] = cookie.split(';')[0].split('=');

  profileDir = mkdtempSync(join(tmpdir(), 'cg-dash-profile-'));
  // chrome-headless-shell is headless by construction and rejects the flag;
  // a full Chrome needs it.
  const headlessFlag = browserPath.includes('headless') ? [] : ['--headless=new'];
  run(browserPath, [
    ...headlessFlag,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ]);

  let devtoolsPort = null;
  await waitFor('the browser', () => {
    const portFile = join(profileDir, 'DevToolsActivePort');
    if (!existsSync(portFile)) return false;
    devtoolsPort = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    return Number.isFinite(devtoolsPort) && devtoolsPort > 0;
  }, 30);

  const version = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`)).json();
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Network.setCookie', { url: BASE, name, value, path: '/', httpOnly: true }, sessionId);

  await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId);
  await waitFor('the dashboard to finish rendering', async () => {
    const view = await cdp.evaluate(sessionId, 'document.body.dataset.ready === "true"');
    return view === true;
  }, 60);

  let view = await cdp.evaluate(sessionId, PROBE);

  // -- what loaded ---------------------------------------------------------
  console.log('\nThe page renders');
  // The very same registry the page just rendered from, imported here so the
  // expectations cannot drift from the panels under test.
  const { PANELS } = await import(pathToFileURL(join(root, 'public', 'panels.js')).href);
  check(`all ${PANELS.length} panels are on the page`, view.panels.length === PANELS.length, `got ${view.panels.length}`);
  const broken = view.panels.filter((p) => p.state !== 'ready');
  check(
    'every panel reached its ready state',
    broken.length === 0,
    broken.map((p) => `${p.id}: ${p.state} ${p.message}`).join(' | '),
  );
  check('the default range is the 30-day preset', view.selectedPreset === 'Last 30 days', view.selectedPreset);
  check('the range is stated in the filter row', /Jun|Jul/.test(view.range), view.range);
  check('the data horizon is stated', view.dataThrough.includes('Jul 10'), view.dataThrough);
  check('the refresh time is stated', view.refreshed.startsWith('Last refreshed'), view.refreshed);

  // A CSP violation surfaces here as a `security` log entry, which is the point
  // of the check: the page must work under `script-src 'self'` with no inline
  // styles at all. The favicon 404 is expected — there isn't one — and is the
  // only network noise allowed through.
  const errors = cdp.events.filter(
    (e) =>
      (e.method === 'Log.entryAdded' &&
        e.params.entry.level === 'error' &&
        !/favicon/.test(e.params.entry.url ?? '')) ||
      e.method === 'Runtime.exceptionThrown',
  );
  check(
    'no console errors — the strict CSP allows everything the page needs',
    errors.length === 0,
    errors.map((e) => e.params.entry?.text ?? e.params.exceptionDetails?.text).join(' | '),
  );

  // -- the range picker really re-queries ----------------------------------
  console.log('\nChanging the range re-queries every panel');
  await cdp.evaluate(
    sessionId,
    `document.body.dataset.ready = "";
     [...document.querySelectorAll('button.range')].find((b) => b.textContent === 'Last 7 days').click();`,
  );
  await waitFor('the 7-day render', async () =>
    (await cdp.evaluate(sessionId, 'document.body.dataset.ready === "true"')) === true,
  );
  view = await cdp.evaluate(sessionId, PROBE);
  const weekly = view.panels.find((p) => p.id === 'daily-production-users');
  check('a daily line now holds 7 points', weekly.chart?.labels.length === 7, `${weekly.chart?.labels.length}`);
  check('the 7-day preset is marked selected', view.selectedPreset === 'Last 7 days', view.selectedPreset);
  check('every panel re-rendered cleanly', view.panels.every((p) => p.state === 'ready'));

  console.log('\nA custom range works the same way');
  await cdp.evaluate(
    sessionId,
    `document.body.dataset.ready = "";
     document.querySelector('[data-role="custom-from"]').value = "${FROM}";
     document.querySelector('[data-role="custom-to"]').value = "${TO}";
     document.querySelector('[data-role="custom-apply"]').click();`,
  );
  await waitFor('the custom-range render', async () =>
    (await cdp.evaluate(sessionId, 'document.body.dataset.ready === "true"')) === true,
  );
  view = await cdp.evaluate(sessionId, PROBE);
  check('the fixture window is 10 days', view.panels.find((p) => p.id === 'daily-production-users').chart?.labels.length === 10);
  check('no preset stays highlighted', view.selectedPreset === null, view.selectedPreset);

  // -- every panel plots what the API returned ------------------------------
  console.log('\nEvery panel plots the API’s own numbers');
  const query = `from=${FROM}&to=${TO}`;
  const fetched = new Map();
  const apiGet = async (path) => {
    if (!fetched.has(path)) {
      fetched.set(
        path,
        fetch(`${BASE}${path}`, { headers: { cookie: `${name}=${value}` } }).then((r) => r.json()),
      );
    }
    return fetched.get(path);
  };

  for (const panel of PANELS) {
    const rendered = view.panels.find((p) => p.id === panel.id);
    const data = await apiGet(panel.source(query));

    if (panel.kind === 'chart') {
      const plotted = rendered.chart?.datasets.map((d) => d.data);
      same(`${panel.id}: plots the endpoint's series`, data.datasets.map((d) => d.data), plotted);
      // A legend is owed wherever colour carries identity: any multi-series
      // chart, and every pie (whose slices are identities inside one dataset).
      // A single line needs none — the panel title already names it.
      const owed = rendered.chart.type === 'pie' || data.datasets.length > 1;
      check(
        `${panel.id}: a legend exactly where colour carries identity`,
        rendered.chart.legend === owed,
        `legend ${rendered.chart.legend}, expected ${owed}`,
      );
    } else if (panel.kind === 'stat') {
      same(`${panel.id}: shows the endpoint's number`, panel.stat(data).value, rendered.stat);
    } else if (panel.kind === 'funnel') {
      same(
        `${panel.id}: shows both funnel stages`,
        panel.funnel(data).stages.map((s) => s.value.toLocaleString('en-US')),
        rendered.funnelValues,
      );
    }

    const table = panel.table(data);
    check(
      `${panel.id}: the table twin carries every row`,
      rendered.tableRows === table.rows.length && rendered.tableCols === table.columns.length,
      `${rendered.tableRows}×${rendered.tableCols} vs ${table.rows.length}×${table.columns.length}`,
    );
  }

  // -- a few numbers checked against the fixture by hand --------------------
  console.log('\nSpot checks against the fixture, worked out by hand');
  const byId = Object.fromEntries(view.panels.map((p) => [p.id, p]));
  same('production users is 11 (m12 is the CI machine)', '11', byId['production-users'].stat);
  same('installs is 12', '12', byId['installs'].stat);
  same('uninstalls is 2', '2', byId['uninstalls'].stat);
  same('indexing runs is 13', '13', byId['indexing-runs'].stat);
  same('the funnel loses m04 and m06', ['12', '10'], byId['activation-funnel'].funnelValues);
  const widths = byId['activation-funnel'].funnelWidths;
  check(
    '…and draws the drop as a shorter bar',
    widths[0] === '100%' && widths[1].startsWith('83.3'),
    widths.join(' / '),
  );
  same('the OS pie is machine-days', ['linux', 'darwin', 'win32'], byId.os.chart.labels);
  same('…and its slices are 9 / 8 / 4', [[9, 8, 4]], byId.os.chart.datasets.map((d) => d.data));
  check('…with the honest metric named under the title', byId.os.figure === '21 machine-days', byId.os.figure);
  same('run length keeps its bucket order', ['<10s', '10-60s', '1-5m', '5m+'], byId['run-length'].chart.labels);
  same('languages lead with typescript', 'typescript', byId.languages.chart.labels[0]);
  check('retention starts at 100%', byId.retention.chart.datasets[0].data[0] === 100);

  // Colour, spacing and label collisions are not things an assertion catches.
  // RENDER_SHOT=/tmp/dash.png npm run smoke:render → look at it.
  if (process.env.RENDER_SHOT) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false },
      sessionId,
    );
    await sleep(500);
    const shot = await cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true },
      sessionId,
    );
    writeFileSync(process.env.RENDER_SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\nScreenshot written to ${process.env.RENDER_SHOT}`);
  }

  console.log('\nPanel copy follows the house rules');
  const capsy = view.panels.filter((p) => /^[A-Z0-9 ]{4,}$/.test(p.title));
  check('no shouty panel titles', capsy.length === 0, capsy.map((p) => p.title).join(', '));
  check('every panel says what it is counting', view.panels.every((p) => p.note.length > 20));
  check('tables start closed', view.panels.every((p) => p.tableHidden));

  return fail;
}

try {
  const failures = await main();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error(`\nrender-check: ${err.message}`);
  process.exit(1);
}
