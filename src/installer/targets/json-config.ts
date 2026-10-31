/**
 * `mcpServers.codegraph` in an agent's JSON config, for the targets whose file
 * has that shape.
 *
 * The file is edited in place with `jsonc-parser`, not rewritten: it keeps its
 * indent and line breaks, and comments survive in the agents that allow them
 * (Qwen Code, Qoder). A file that can't be parsed is backed up before it is
 * replaced, as `writeJsonFile` does (#1870).
 *
 * An entry already in the file is the user's. Agents write into it themselves:
 * a disabled switch, an `alwaysAllow` list, Pi's `exposure`. Users pin a
 * `command` or a `cwd` there. So a re-install or the `install --refresh` that
 * `codegraph upgrade` runs only fills in a key that is missing, and never
 * changes one that is set.
 *
 * The servers map is `mcpServers` unless a caller names another path. VS Code
 * keeps its servers under `servers`, ZCode under `mcp.servers`, Zed under
 * `context_servers`. Each function takes that path as its last argument and
 * reads `mcpServers` when it is left out, so a caller that passes nothing is
 * not changed by it. A wrapper the removal leaves empty goes with the entry,
 * from the servers map up, so the file reads as it did before the install.
 */

import * as fs from 'fs';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import type { WriteResult } from './types';
import { atomicWriteFileSync, backupUnparseableJson, removeFileUnlessLinked } from './shared';

type FileResult = WriteResult['files'][number];
type Edit = (text: string) => string;

/** The keys from the top of the file down to the servers map. */
export type ServersPath = readonly string[];

export const DEFAULT_SERVERS_PATH: ServersPath = ['mcpServers'];
const noEdit: Edit = (text) => text;

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfig(text: string): { config: Record<string, any>; valid: boolean } {
  const body = text.replace(/^﻿/, '');
  if (body.trim() === '') return { config: {}, valid: true };
  const errors: ParseError[] = [];
  const value: unknown = parse(body, errors, { allowTrailingComma: true });
  return isObject(value) && errors.length === 0 ? { config: value, valid: true } : { config: {}, valid: false };
}

/** The value `keys` lead to in `config`, or undefined when a step is missing or not an object. */
function valueAt(config: Record<string, any>, keys: ServersPath): unknown {
  let current: unknown = config;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** The object in `text`, or `{}` when it holds none. */
export function parseJsonConfig(text: string): Record<string, any> {
  return parseConfig(text).config;
}

/** `text` with the value at `jsonPath` set, or removed when `value` is undefined. Everything else stays. */
export function editJson(
  text: string,
  jsonPath: Array<string | number>,
  value: unknown,
  options: { isArrayInsertion?: boolean } = {},
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ';
  const insertSpaces = !indent.startsWith('\t');
  return applyEdits(text, modify(text, jsonPath, value, {
    ...options,
    formattingOptions: { tabSize: insertSpaces ? indent.length : 1, insertSpaces, eol },
  }));
}

/**
 * Whether `file` defines CodeGraph's server. Read-only and quiet: `detect()`
 * runs this for every agent on every install (#1870).
 */
export function hasCodegraphServer(file: string, serversPath: ServersPath = DEFAULT_SERVERS_PATH): boolean {
  try {
    const servers = valueAt(parseConfig(fs.readFileSync(file, 'utf-8')).config, serversPath);
    return isObject(servers) && !!servers.codegraph;
  } catch {
    return false;
  }
}

/**
 * Add CodeGraph's server to `file`, or the keys of `entry` an existing one is
 * missing. `alsoEdit` runs on the same text, for a target with more to write in
 * this file, so the file is written once and reported once.
 */
export function upsertCodegraphServer(
  file: string,
  entry: Record<string, unknown>,
  alsoEdit: Edit = noEdit,
  serversPath: ServersPath = DEFAULT_SERVERS_PATH,
): FileResult {
  const existed = fs.existsSync(file);
  const before = existed ? fs.readFileSync(file, 'utf-8') : '';
  const { config, valid } = parseConfig(before);

  // Every step down to the servers map is an object or absent. A value of
  // another kind cannot hold the server, and the file is left as it is.
  let servers: Record<string, any> | undefined = config;
  for (let depth = 0; depth < serversPath.length && servers !== undefined; depth++) {
    const next: unknown = servers[serversPath[depth]!];
    if (next !== undefined && !isObject(next)) {
      const dotted = serversPath.slice(0, depth + 1).join('.');
      throw new Error(
        `${file} sets ${dotted} to something other than an object, so CodeGraph can't add its server. ` +
        `Nothing was changed: make ${dotted} an object, then run this again.`,
      );
    }
    servers = next as Record<string, any> | undefined;
  }
  if (!valid) backupUnparseableJson(file);

  let text = valid && before.trim() !== '' ? before : '{\n}\n';
  const serverPath = [...serversPath, 'codegraph'];
  const current: unknown = servers?.codegraph;
  if (isObject(current)) {
    for (const [key, value] of Object.entries(entry)) {
      if (!(key in current)) text = editJson(text, [...serverPath, key], value);
    }
  } else {
    text = editJson(text, serverPath, entry);
  }
  text = alsoEdit(text);

  if (text === before) return { path: file, action: 'unchanged' };
  atomicWriteFileSync(file, text);
  return { path: file, action: existed ? 'updated' : 'created' };
}

/**
 * Inverse of `upsertCodegraphServer`: take out CodeGraph's server, each
 * wrapper up to the top of the file that held nothing else, and whatever
 * `alsoEdit` takes out. A file with nothing left in it is deleted, so uninstall
 * reverses a from-scratch install. A symbolic link is the user's, so it is
 * kept, with `{}` written through it (#2721).
 */
export function removeCodegraphServer(
  file: string,
  alsoEdit: Edit = noEdit,
  serversPath: ServersPath = DEFAULT_SERVERS_PATH,
): FileResult {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const before = fs.readFileSync(file, 'utf-8');
  const { config, valid } = parseConfig(before);
  if (!valid) return { path: file, action: 'not-found' };

  let text = before;
  const servers = valueAt(config, serversPath);
  if (isObject(servers) && 'codegraph' in servers) {
    text = editJson(text, [...serversPath, 'codegraph'], undefined);
    // The wrapper that held only our entry goes too, then its own wrapper
    // when that held only it, up to the top of the file.
    let emptied = Object.keys(servers).length === 1;
    for (let depth = serversPath.length; depth >= 1 && emptied; depth--) {
      text = editJson(text, [...serversPath.slice(0, depth)], undefined);
      const parent = valueAt(config, serversPath.slice(0, depth - 1));
      emptied = depth > 1 && isObject(parent) && Object.keys(parent).length === 1;
    }
  }
  text = alsoEdit(text);

  if (text === before) return { path: file, action: 'not-found' };
  if (/^\s*\{\s*\}\s*$/.test(text)) removeFileUnlessLinked(file, '{}\n');
  else atomicWriteFileSync(file, text);
  return { path: file, action: 'removed' };
}
