/**
 * WASM runtime flags — workaround for the V8 turboshaft WASM Zone OOM.
 *
 * tree-sitter grammars are large WebAssembly modules. On Node >= 22 the V8
 * "turboshaft" optimizing WASM compiler can exhaust its per-compilation Zone
 * arena while compiling these grammars on a background thread, aborting the
 * whole process with `Fatal process out of memory: Zone` — even with tens of
 * GB of system memory free, because the Zone is a V8-internal arena, not the
 * JS heap. Reproduced on Node 22 and 24; Node 25 is already hard-blocked for
 * the same crash (see ../bin/node-version-check.ts). See issues #293 and #298.
 *
 * `--liftoff-only` forces every WASM module to the Liftoff baseline compiler
 * and never runs turboshaft, which eliminates the crash. Parsing stays fully
 * correct; we only forgo the (marginal, and for grammars rarely reached)
 * optimized-tier speedup.
 *
 * This flag MUST be on node's command line — it is read by V8 at engine init,
 * before any of our JS runs. Empirically (Node 24) none of these work:
 *   - `v8.setFlagsFromString('--liftoff-only')` at runtime — too late.
 *   - Worker `execArgv: ['--liftoff-only']` — rejected (ERR_WORKER_INVALID_EXEC_ARGV).
 *   - `NODE_OPTIONS=--liftoff-only` — not on Node's NODE_OPTIONS allowlist.
 * Also empirically, `--no-wasm-tier-up` / `--no-wasm-dynamic-tiering` do NOT
 * prevent the crash — only disabling the optimizing tier entirely does.
 *
 * Delivery: the bundled launcher passes the flag directly (see
 * scripts/build-bundle.sh and scripts/npm-shim.js); for any other launch path
 * (running dist directly, from source, etc.) the CLI re-execs itself once with
 * the flag via {@link relaunchWithWasmRuntimeFlagsIfNeeded}. V8 flags are
 * PROCESS-global, and the parse worker is created with default (inherited)
 * execArgv, so flagging the main process governs the worker's WASM compilation
 * too.
 */
import { spawnSync } from 'child_process';

/**
 * The V8 flag(s) that keep tree-sitter grammar compilation off the turboshaft
 * optimizing tier. Single source of truth: the relaunch guard and the test
 * suite both read this (a test asserts each is a real flag on the running
 * runtime, so a rename can't silently regress the fix).
 */
export const WASM_RUNTIME_FLAGS: readonly string[] = ['--liftoff-only'];

/**
 * Node CLI options (not V8 flags) passed alongside the WASM flags on every
 * launch path. `--disable-warning=ExperimentalWarning` mutes node:sqlite's
 * "SQLite is an experimental feature" warning, which is emitted once per
 * THREAD — the main process plus every parse worker — so during indexing it
 * prints repeatedly, interleaved with the progress UI. Node options apply
 * process-wide (workers inherit them), so the command line covers everything.
 *
 * Deliberately NOT part of the {@link processHasWasmRuntimeFlags} re-exec
 * gate: a launcher passing only the WASM flags (an older installed bundle
 * running a newer dist) must not trigger a whole re-exec over a cosmetic
 * warning.
 */
export function nodeRuntimeFlagsFor(nodeVersion: string): readonly string[] {
  // `--disable-warning` landed in Node 20.11 / 21.3; older nodes treat it as
  // a fatal "bad option" at spawn. Those runtimes can't run codegraph anyway
  // (node:sqlite needs >= 22.5), but let them reach our own version messaging
  // instead of a cryptic spawn failure.
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  const supported = major > 21 || (major === 21 && minor >= 3) || (major === 20 && minor >= 11);
  return supported ? ['--disable-warning=ExperimentalWarning'] : [];
}

export const NODE_RUNTIME_FLAGS: readonly string[] = nodeRuntimeFlagsFor(process.versions.node);

/**
 * Env var set on the relaunched child so a detection slip can never cause an
 * infinite re-exec loop. Also lets users force-disable the relaunch.
 */
const RELAUNCH_GUARD_ENV = 'CODEGRAPH_WASM_RELAUNCHED';

/**
 * Env var carrying the *host* PID (the relauncher's own parent) across the
 * re-exec. Without `--liftoff-only` the CLI re-execs itself once, inserting an
 * intermediate process between the MCP host and the server. That intermediate
 * stays alive (blocked in spawnSync) even after the host is killed, so the
 * server's PPID watchdog can't detect the host's death by watching its own
 * `process.ppid`. Passing the host PID through lets the watchdog poll it
 * directly. Unset on the no-re-exec path (bundled launcher / flag already
 * present), where the server is already a direct child of the host. See
 * src/mcp/index.ts (#277).
 */
export const HOST_PPID_ENV = 'CODEGRAPH_HOST_PPID';

/** True when every required WASM runtime flag is already present in `execArgv`. */
export function processHasWasmRuntimeFlags(
  execArgv: readonly string[] = process.execArgv
): boolean {
  return WASM_RUNTIME_FLAGS.every((flag) => execArgv.includes(flag));
}

/**
 * Build the argv for re-execing node with the WASM runtime flags: our flags
 * first, then any node flags already in `execArgv` (deduped), then the script
 * and its args. Pure — exported for unit testing.
 */
export function buildRelaunchArgv(
  scriptPath: string,
  scriptArgs: readonly string[],
  execArgv: readonly string[] = process.execArgv
): string[] {
  const preserved = execArgv.filter(
    (arg) => !WASM_RUNTIME_FLAGS.includes(arg) && !NODE_RUNTIME_FLAGS.includes(arg)
  );
  return [...NODE_RUNTIME_FLAGS, ...WASM_RUNTIME_FLAGS, ...preserved, scriptPath, ...scriptArgs];
}

/**
 * If the current process is missing the WASM runtime flags, re-exec it once
 * with them and exit with the child's status. No-op when the flags are already
 * present (the normal bundled-launcher path), when already relaunched, or when
 * disabled via CODEGRAPH_NO_RELAUNCH.
 *
 * On spawn failure, returns so the caller runs in-process anyway — risking the
 * OOM is still better than refusing to start.
 */
export function relaunchWithWasmRuntimeFlagsIfNeeded(scriptPath: string): void {
  if (processHasWasmRuntimeFlags()) return;
  if (process.env[RELAUNCH_GUARD_ENV]) return;
  if (process.env.CODEGRAPH_NO_RELAUNCH) return;

  const argv = buildRelaunchArgv(scriptPath, process.argv.slice(2));
  const result = spawnSync(process.execPath, argv, {
    stdio: 'inherit',
    env: { ...process.env, [RELAUNCH_GUARD_ENV]: '1', [HOST_PPID_ENV]: String(process.ppid) },
    windowsHide: true,
  });

  if (result.error) {
    // Couldn't relaunch (e.g. execPath unavailable) — fall through and run in
    // this process. Degraded (may OOM on huge repos) but not broken.
    return;
  }
  process.exit(result.status ?? (result.signal ? 1 : 0));
}
