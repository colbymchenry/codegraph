import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Node } from '../types';
import { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

interface LeanLspWorkerLocation {
  index: number;
  uri: string;
  line: number;
  column: number;
}

interface LeanLspWorkerOutput {
  locations?: LeanLspWorkerLocation[];
}

const DEFAULT_LEAN_LSP_TIMEOUT_MS = 2_000;
const DEFAULT_LEAN_LSP_REF_LIMIT = 100;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function commandExists(command: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        fs.accessSync(path.join(dir, command + ext), fs.constants.X_OK);
        return true;
      } catch {
        // keep searching
      }
    }
  }
  return false;
}

function leanLspCommand(): string | null {
  const override = process.env.CODEGRAPH_LEAN_LSP_COMMAND?.trim();
  if (override) return override;
  if (commandExists('lake')) return 'lake env lean --server';
  if (commandExists('lean')) return 'lean --server';
  return null;
}

function isLeanSemanticsEnabled(): boolean {
  const mode = (process.env.CODEGRAPH_LEAN_SEMANTICS ?? 'auto').trim().toLowerCase();
  return mode !== 'off' && mode !== 'false' && mode !== '0';
}

function uriToProjectPath(uri: string, projectRoot: string): string | null {
  try {
    const absolutePath = fileURLToPath(uri);
    const relativePath = path.relative(projectRoot, absolutePath).replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }
    return relativePath;
  } catch {
    return null;
  }
}

function containsPosition(node: Node, line: number, column: number): boolean {
  if (line < node.startLine || line > node.endLine) return false;
  if (line === node.startLine && column < node.startColumn) return false;
  if (line === node.endLine && column > node.endColumn) return false;
  return true;
}

function findSmallestCoveringNode(
  filePath: string,
  line: number,
  column: number,
  context: ResolutionContext
): Node | null {
  const candidates = context
    .getNodesInFile(filePath)
    .filter((node) => node.kind !== 'file' && containsPosition(node, line, column));
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aSpan = (a.endLine - a.startLine) * 10_000 + (a.endColumn - a.startColumn);
    const bSpan = (b.endLine - b.startLine) * 10_000 + (b.endColumn - b.startColumn);
    if (aSpan !== bSpan) return aSpan - bSpan;
    return b.startLine - a.startLine;
  });
  return candidates[0] ?? null;
}

/**
 * Resolve Lean references through `textDocument/definition` when a Lean LSP is
 * available. This is deliberately best-effort: any missing command, timeout,
 * malformed response, or project-external location returns an empty map and the
 * static resolver continues unchanged.
 */
export function resolveLeanLspBatch(
  refs: UnresolvedRef[],
  context: ResolutionContext
): Map<number, ResolvedRef> {
  const resolved = new Map<number, ResolvedRef>();
  if (!isLeanSemanticsEnabled()) return resolved;

  const command = leanLspCommand();
  if (!command) return resolved;

  const refLimit = parsePositiveInt(process.env.CODEGRAPH_LEAN_LSP_REF_LIMIT, DEFAULT_LEAN_LSP_REF_LIMIT);
  const timeoutMs = parsePositiveInt(process.env.CODEGRAPH_LEAN_LSP_TIMEOUT_MS, DEFAULT_LEAN_LSP_TIMEOUT_MS);
  const leanRefs = refs
    .map((ref, index) => ({ ref, index }))
    .filter(({ ref }) => ref.language === 'lean' && ref.referenceKind !== 'imports')
    .slice(0, refLimit);
  if (leanRefs.length === 0) return resolved;

  const workerInput = {
    command,
    projectRoot: context.getProjectRoot(),
    timeoutMs,
    refs: leanRefs.map(({ ref, index }) => ({
      index,
      filePath: ref.filePath,
      line: ref.line,
      column: ref.column,
    })),
  };

  const totalTimeoutMs = Math.max(timeoutMs, Math.min(10_000, timeoutMs * 2 + leanRefs.length * 50));
  const result = spawnSync(process.execPath, ['-e', LEAN_LSP_WORKER_SOURCE], {
    input: JSON.stringify(workerInput),
    encoding: 'utf-8',
    timeout: totalTimeoutMs,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });

  if (result.error || result.status !== 0 || !result.stdout.trim()) return resolved;

  let parsed: LeanLspWorkerOutput;
  try {
    parsed = JSON.parse(result.stdout) as LeanLspWorkerOutput;
  } catch {
    return resolved;
  }

  for (const location of parsed.locations ?? []) {
    const ref = refs[location.index];
    if (!ref) continue;

    const targetPath = uriToProjectPath(location.uri, context.getProjectRoot());
    if (!targetPath) continue;

    const targetNode = findSmallestCoveringNode(
      targetPath,
      location.line,
      location.column,
      context
    );
    if (!targetNode) continue;

    resolved.set(location.index, {
      original: ref,
      targetNodeId: targetNode.id,
      confidence: 0.99,
      resolvedBy: 'lean-lsp',
    });
  }

  return resolved;
}

const LEAN_LSP_WORKER_SOURCE = String.raw`
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function writeOutput(locations) {
  process.stdout.write(JSON.stringify({ locations }));
}

function makeRpc(child) {
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();

  function sendMessage(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    child.stdin.write(Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'));
    child.stdin.write(body);
  }

  function handleMessage(message) {
    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const entry = pending.get(message.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  }

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString('ascii');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (buffer.length < messageEnd) return;
      const body = buffer.slice(messageStart, messageEnd).toString('utf8');
      buffer = buffer.slice(messageEnd);
      try {
        handleMessage(JSON.parse(body));
      } catch {
        // Ignore malformed server output.
      }
    }
  });

  function request(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      sendMessage({ jsonrpc: '2.0', id, method, params });
    });
  }

  function notify(method, params) {
    sendMessage({ jsonrpc: '2.0', method, params });
  }

  return { request, notify };
}

function lspUri(projectRoot, filePath) {
  return pathToFileURL(path.join(projectRoot, filePath)).href;
}

function locationFromResult(index, result) {
  const value = Array.isArray(result) ? result[0] : result;
  if (!value) return null;
  const uri = value.uri || value.targetUri;
  const range = value.range || value.targetSelectionRange || value.targetRange;
  if (!uri || !range || !range.start) return null;
  return {
    index,
    uri,
    line: (range.start.line ?? 0) + 1,
    column: range.start.character ?? 0,
  };
}

(async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    writeOutput([]);
    return;
  }

  const timeoutMs = input.timeoutMs || 2000;
  const child = spawn(input.command, {
    cwd: input.projectRoot,
    shell: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  let spawnFailed = false;
  child.on('error', () => { spawnFailed = true; });

  const rpc = makeRpc(child);
  const rootUri = pathToFileURL(input.projectRoot.endsWith(path.sep) ? input.projectRoot : input.projectRoot + path.sep).href;
  const initialized = await rpc.request('initialize', {
    processId: process.pid,
    rootUri,
    capabilities: {},
    workspaceFolders: null,
  }, timeoutMs);

  if (spawnFailed || !initialized) {
    child.kill();
    writeOutput([]);
    return;
  }

  rpc.notify('initialized', {});

  const opened = new Set();
  const locations = [];
  for (const ref of input.refs || []) {
    if (!opened.has(ref.filePath)) {
      opened.add(ref.filePath);
      let text = '';
      try {
        text = fs.readFileSync(path.join(input.projectRoot, ref.filePath), 'utf8');
      } catch {
        continue;
      }
      rpc.notify('textDocument/didOpen', {
        textDocument: {
          uri: lspUri(input.projectRoot, ref.filePath),
          languageId: 'lean4',
          version: 1,
          text,
        },
      });
    }

    const response = await rpc.request('textDocument/definition', {
      textDocument: { uri: lspUri(input.projectRoot, ref.filePath) },
      position: {
        line: Math.max(0, (ref.line || 1) - 1),
        character: Math.max(0, ref.column || 0),
      },
    }, timeoutMs);
    const location = response ? locationFromResult(ref.index, response.result) : null;
    if (location) locations.push(location);
  }

  child.kill();
  writeOutput(locations);
})().catch(() => {
  writeOutput([]);
});
`;
