import { execFile, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';

const require = createRequire(import.meta.url);
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 2000;

// Prefer this package's installed runtime: no PATH setup, shell, or download.
// The standalone CLI remains usable when loading the extension from source.
function installedCommand(): { command: string; args: string[] } | undefined {
  const pkg = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
  try {
    return {
      command: require.resolve(`${pkg}/${process.platform === 'win32' ? 'node.exe' : 'node'}`),
      args: ['--liftoff-only', '--disable-warning=ExperimentalWarning',
        require.resolve(`${pkg}/lib/dist/bin/codegraph.js`), 'prompt-hook'],
    };
  } catch {
    const command = Bun.which('codegraph');
    // Windows npm/standalone .cmd launchers require a shell. Use the installed
    // platform package above instead; never execute a project-supplied command.
    if (!command || /\.(cmd|bat)$/i.test(command)) return undefined;
    return { command, args: ['prompt-hook'] };
  }
}

/** Native OMP integration; the existing CLI owns project discovery and queries. */
export default function codegraph(omp: ExtensionAPI): void {
  const installed = installedCommand();
  let generation = 0;
  let cancel: (() => void) | undefined;
  const reset = () => {
    generation++;
    cancel?.();
    cancel = undefined;
  };
  for (const event of ['session_start', 'session_switch', 'session_branch', 'session_tree', 'session_shutdown'] as const) {
    omp.on(event, reset);
  }

  omp.on('before_agent_start', async (event, ctx) => {
    reset();
    if (!ctx.isProjectTrusted() || !installed || process.env.CODEGRAPH_NO_PROMPT_HOOK === '1' || process.env.CODEGRAPH_PROMPT_HOOK === '0') return;
    // Reject before serializing as well as after: JSON escaping can grow input.
    if (event.prompt.length > MAX_INPUT_BYTES || ctx.cwd.length > MAX_INPUT_BYTES) return;
    const input = JSON.stringify({ prompt: event.prompt, cwd: ctx.cwd });
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) return;
    const current = generation;
    const cwd = ctx.cwd;
    const content = await new Promise<string | undefined>((resolve) => {
      let child: ChildProcess | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (output?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A PATH launcher can spawn the real CLI. Kill its process group too,
        // including when a descendant keeps stdout open after its parent exits.
        try {
          if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, 'SIGKILL');
          else child?.kill('SIGKILL');
        } catch { /* Already exited. */ }
        resolve(output);
      };
      cancel = () => finish();
      try {
        child = execFile(installed.command, installed.args, {
          cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, killSignal: 'SIGKILL',
          detached: process.platform !== 'win32', windowsHide: true,
          env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, CODEGRAPH_NO_DOWNLOAD: '1' },
        }, (error, stdout) => finish(error ? undefined : stdout.trim() || undefined));
        timer = setTimeout(() => finish(), TIMEOUT_MS);
        child.stdin?.on('error', () => finish());
        child.stdin?.end(input);
      } catch {
        finish();
      }
    });
    if (current !== generation) return;
    cancel = undefined;
    if (!ctx.isProjectTrusted() || ctx.cwd !== cwd || !content) return;
    // prompt-hook emits raw tagged context, not Claude hook JSON. Never inject
    // launcher diagnostics or a partial result as agent instructions.
    if (!/^<codegraph_context(?:\s[^>]*)?>[\s\S]*<\/codegraph_context>$/.test(content)) return;
    return { message: { customType: 'codegraph-context', content, display: false } };
  });
}
