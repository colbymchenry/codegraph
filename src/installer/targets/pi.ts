/**
 * Pi target.
 *
 * Pi has no built-in MCP client. Instead, it supports TypeScript
 * extensions that can register native model-callable tools, plus AGENTS.md /
 * CLAUDE.md context files. We install:
 *
 *   - a native Pi extension that registers `codegraph_explore` and shells out
 *     to `codegraph explore`, the CLI face of CodeGraph's MCP explore tool.
 *   - the short marker-fenced CodeGraph instructions block in Pi's AGENTS.md
 *     context so the model knows when to use the tool.
 *
 * Global Pi config lives in `${PI_CODING_AGENT_DIR:-~/.pi/agent}`. Project-
 * local extensions live in `./.pi/extensions/` and load after the user trusts
 * the project; project context lives in `./AGENTS.md` / `./CLAUDE.md`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  CODEGRAPH_INSTRUCTIONS_BLOCK,
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../instructions-template';

const EXTENSION_START = '// CODEGRAPH_PI_EXTENSION_START';
const EXTENSION_END = '// CODEGRAPH_PI_EXTENSION_END';

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith(`~${path.sep}`) || p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function piAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env && env.trim().length > 0) return path.resolve(expandHome(env.trim()));
  return path.join(os.homedir(), '.pi', 'agent');
}

function localPiDir(): string {
  return path.join(process.cwd(), '.pi');
}

function instructionsPath(loc: Location): string {
  return loc === 'global'
    ? path.join(piAgentDir(), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

function localClaudePath(): string {
  return path.join(process.cwd(), 'CLAUDE.md');
}

function extensionPath(loc: Location): string {
  return loc === 'global'
    ? path.join(piAgentDir(), 'extensions', 'codegraph.ts')
    : path.join(localPiDir(), 'extensions', 'codegraph.ts');
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function hasInstructionsMarker(file: string): boolean {
  const text = readText(file);
  return text.includes(CODEGRAPH_SECTION_START) && text.includes(CODEGRAPH_SECTION_END);
}

function hasExtensionMarker(file: string): boolean {
  const text = readText(file);
  return text.includes(EXTENSION_START) && text.includes(EXTENSION_END);
}

function piExecutableOnPath(): boolean {
  const pathEnv = process.env.PATH ?? '';
  if (!pathEnv.trim()) return false;
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    : [''];

  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `pi${suffix}`);
      try {
        if (process.platform === 'win32') {
          if (fs.existsSync(candidate)) return true;
        } else {
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        }
      } catch {
        // keep scanning
      }
    }
  }
  return false;
}

class PiTarget implements AgentTarget {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi';
  readonly docsUrl = 'https://pi.dev';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const ext = extensionPath(loc);
    const instructions = instructionsPath(loc);
    const alreadyConfigured = hasExtensionMarker(ext) ||
      hasInstructionsMarker(instructions) ||
      (loc === 'local' && hasInstructionsMarker(localClaudePath()));

    const installed = loc === 'global'
      ? fs.existsSync(piAgentDir()) || fs.existsSync(ext) || alreadyConfigured || piExecutableOnPath()
      : fs.existsSync(localPiDir()) || fs.existsSync(ext) || alreadyConfigured || piExecutableOnPath();

    return { installed, alreadyConfigured, configPath: ext };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeExtensionEntry(loc));
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    const notes = loc === 'local'
      ? ['Restart Pi or run /reload. For project-local extensions, approve project trust if Pi asks.']
      : ['Restart Pi or run /reload for the CodeGraph tool to load.'];

    return { files, notes };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(removeExtensionEntry(loc));
    const action = removeMarkedSection(
      instructionsPath(loc),
      CODEGRAPH_SECTION_START,
      CODEGRAPH_SECTION_END,
    );
    files.push({ path: instructionsPath(loc), action });
    return { files };
  }

  printConfig(loc: Location): string {
    return [
      '# Pi does not use MCP config directly. Add this native extension and context block instead.',
      '',
      `# Add to ${extensionPath(loc)}`,
      '',
      buildExtensionSource().trimEnd(),
      '',
      `# Add to ${instructionsPath(loc)}`,
      '',
      CODEGRAPH_INSTRUCTIONS_BLOCK,
      '',
    ].join('\n');
  }

  describePaths(loc: Location): string[] {
    return [extensionPath(loc), instructionsPath(loc)];
  }
}

function writeExtensionEntry(loc: Location): WriteResult['files'][number] {
  const file = extensionPath(loc);
  const existed = fs.existsSync(file);
  const before = readText(file);
  const after = buildExtensionSource();

  if (before === after) {
    return { path: file, action: 'unchanged' };
  }

  // `codegraph.ts` is the file name this target owns. If an older or edited
  // CodeGraph-generated file is present, replace it. If an unrelated file is
  // present at the same path, we still update it because the path itself is the
  // installer-owned integration point, matching Kiro's owned steering file.
  atomicWriteFileSync(file, after);
  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeExtensionEntry(loc: Location): WriteResult['files'][number] {
  const file = extensionPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  if (!hasExtensionMarker(file)) return { path: file, action: 'not-found' };
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return { path: file, action: 'removed' };
}

function buildExtensionSource(): string {
  return `${EXTENSION_START}
// Generated by CodeGraph. Re-run codegraph install --target=pi to update.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

const MAX_OUTPUT_CHARS = 200000;

type ExploreParams = {
  query: string;
  projectPath?: string;
  maxFiles?: number;
};

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export default function (pi: ExtensionAPI) {
  // Register at session_start, NOT at extension load. A user may install
  // CodeGraph for Pi both globally and project-locally; Pi loads both scopes
  // in a trusted project and rejects two extensions registering the same tool
  // name at load time (and action methods like getAllTools cannot run during
  // load). Deferring to session_start lets the second-loaded extension see the
  // already-registered tool and skip, instead of crashing the whole session.
  pi.on("session_start", (_event, _ctx) => {
    try {
      if (pi.getAllTools().some((tool) => tool.name === "codegraph_explore")) {
        return;
      }
    } catch {
      // If getAllTools is unavailable for any reason, fall through and register.
    }
    registerCodegraphExplore(pi);
  });
}

function registerCodegraphExplore(pi: ExtensionAPI) {
  pi.registerTool({
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description: "Explore an indexed codebase with CodeGraph, returning relevant source and call paths.",
    promptSnippet: "Explore indexed code with CodeGraph before grep/read for structural questions",
    promptGuidelines: [
      "Use codegraph_explore before grep/find/read when the user asks how code works, where behavior lives, what calls what, impact, or a flow between symbols in a repository with a .codegraph/ index.",
      "If codegraph_explore says no CodeGraph index exists, continue with normal Pi tools; do not create an index unless the user explicitly asks."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Symbol names, file names, or a short code question to explore." }),
      projectPath: Type.Optional(Type.String({ description: "Project path to use instead of Pi's current working directory." })),
      maxFiles: Type.Optional(Type.Number({ description: "Optional maximum number of files to include." }))
    }),
    async execute(_toolCallId, params: ExploreParams, signal, _onUpdate, ctx) {
      const query = (params.query || "").trim();
      if (!query) {
        return textResult("Provide a query for codegraph_explore, such as a symbol name, file name, or short code question.");
      }

      const projectPath = params.projectPath?.trim() || ctx.cwd;
      const args = ["explore", "--path", projectPath];
      if (typeof params.maxFiles === "number" && Number.isFinite(params.maxFiles)) {
        args.push("--max-files", String(Math.max(1, Math.floor(params.maxFiles))));
      }
      args.push(query);

      const result = await runCodegraph(args, projectPath, signal);
      if (result.error) {
        const code = (result.error as Error & { code?: string }).code;
        const message = code === "ENOENT"
          ? "CodeGraph is not on PATH for Pi. Install it with codegraph install or ensure the codegraph command is available, then restart Pi or run /reload."
          : "CodeGraph could not start: " + result.error.message;
        return textResult(message);
      }

      const combined = [result.stdout, result.stderr].filter((s) => s.trim().length > 0).join("\\n");
      const output = combined.trim() || "codegraph explore exited with code " + (result.code ?? "unknown") + " and produced no output.";
      if (result.code && result.code !== 0) {
        return textResult(cap(output + "\\n\\nCodeGraph did not return a usable graph answer. Continue with normal Pi tools unless the user asks you to initialize or repair CodeGraph."));
      }
      return textResult(cap(output));
    }
  });
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {}
  };
}

function runCodegraph(args: string[], cwd: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("codegraph", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve({ ...result, stdout: cap(result.stdout), stderr: cap(result.stderr) });
    };

    const abort = () => {
      try { child.kill(); } catch { /* ignore */ }
    };

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => { stdout = cap(stdout + String(chunk)); });
    child.stderr?.on("data", (chunk) => { stderr = cap(stderr + String(chunk)); });
    child.on("error", (error) => finish({ code: null, stdout, stderr, error }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + "\\n…(truncated by Pi CodeGraph extension)";
}
${EXTENSION_END}
`;
}

export const piTarget: AgentTarget = new PiTarget();
