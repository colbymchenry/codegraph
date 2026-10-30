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
 */

import * as fs from 'fs';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import type { WriteResult } from './types';
import { atomicWriteFileSync, backupUnparseableJson, removeFileUnlessLinked } from './shared';

type FileResult = WriteResult['files'][number];
type Edit = (text: string) => string;

const SERVER_PATH = ['mcpServers', 'codegraph'];
const noEdit: Edit = (text) => text;

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfig(text: string): { config: Record<string, any>; valid: boolean } {
  const body = text.replace(/^\uFEFF/, '');
  if (body.trim() === '') return { config: {}, valid: true };
  const errors: ParseError[] = [];
  const value: unknown = parse(body, errors, { allowTrailingComma: true });
  return isObject(value) && errors.length === 0 ? { config: value, valid: true } : { config: {}, valid: false };
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
export function hasCodegraphServer(file: string): boolean {
  try {
    return !!parseConfig(fs.readFileSync(file, 'utf-8')).config.mcpServers?.codegraph;
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
): FileResult {
  const existed = fs.existsSync(file);
  const before = existed ? fs.readFileSync(file, 'utf-8') : '';
  const { config, valid } = parseConfig(before);
  const servers: unknown = config.mcpServers;
  if (servers !== undefined && !isObject(servers)) {
    throw new Error(
      `${file} sets mcpServers to something other than an object, so CodeGraph can't add its server. ` +
      'Nothing was changed: make mcpServers an object, then run this again.',
    );
  }
  if (!valid) backupUnparseableJson(file);

  let text = valid && before.trim() !== '' ? before : '{\n}\n';
  const current: unknown = servers?.codegraph;
  if (isObject(current)) {
    for (const [key, value] of Object.entries(entry)) {
      if (!(key in current)) text = editJson(text, [...SERVER_PATH, key], value);
    }
  } else {
    text = editJson(text, SERVER_PATH, entry);
  }
  text = alsoEdit(text);

  if (text === before) return { path: file, action: 'unchanged' };
  atomicWriteFileSync(file, text);
  return { path: file, action: existed ? 'updated' : 'created' };
}

/**
 * Inverse of `upsertCodegraphServer`: take out CodeGraph's server, its
 * `mcpServers` wrapper when that held nothing else, and whatever `alsoEdit`
 * takes out. A file with nothing left in it is deleted, so uninstall reverses a
 * from-scratch install. A symbolic link is the user's, so it is kept, with `{}`
 * written through it (#2721).
 */
export function removeCodegraphServer(file: string, alsoEdit: Edit = noEdit): FileResult {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const before = fs.readFileSync(file, 'utf-8');
  const { config, valid } = parseConfig(before);
  if (!valid) return { path: file, action: 'not-found' };

  let text = before;
  const servers: unknown = config.mcpServers;
  if (isObject(servers) && 'codegraph' in servers) {
    text = editJson(text, SERVER_PATH, undefined);
    if (Object.keys(servers).length === 1) text = editJson(text, ['mcpServers'], undefined);
  }
  text = alsoEdit(text);

  if (text === before) return { path: file, action: 'not-found' };
  if (/^\s*\{\s*\}\s*$/.test(text)) removeFileUnlessLinked(file, '{}\n');
  else atomicWriteFileSync(file, text);
  return { path: file, action: 'removed' };
}
