import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface ActiveHdlProfile {
  name: string;
  files: string[];
  includeDirs: string[];
  defines: Record<string, string>;
  topModules: string[];
  languageMode: 'verilog' | 'systemverilog';
  /** Filelist contents participate in the fingerprint; include contents belong to preprocessing dependencies. */
  dependencies: Array<{ path: string; sha256: string }>;
  fingerprint: string;
}
export interface HdlProfileLoadResult {
  status: 'none' | 'active' | 'invalid-config' | 'invalid-profile';
  profile: ActiveHdlProfile | null;
  diagnostics: string[];
  configInvalid: boolean;
  configPresent: boolean;
}
interface ProfileSpec {
  files: string[];
  filelists: string[];
  includeDirs: string[];
  defines: Record<string, string>;
  topModules: string[];
  languageMode: 'verilog' | 'systemverilog';
}
export function isReservedHdlPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(part => part === '.git' || part === '.jj' || part === '.codegraph' || part.startsWith('.codegraph-'));
}
const MAX_BYTES = 1024 * 1024, MAX_LISTS = 256, MAX_DEPTH = 32, MAX_TOKENS = 100000;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(message: string): never { throw new Error(message); }
function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && v.trim().length > 0)) fail(`${label}: expected an array of non-empty strings`);
  return value;
}
function strictKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label}: unsupported field ${key}`);
}
function spec(value: unknown, label: string): ProfileSpec {
  if (!object(value)) fail(`${label}: expected an object`);
  strictKeys(value, ['files', 'filelists', 'includeDirs', 'defines', 'topModules', 'languageMode'], label);
  const defines: Record<string, string> = Object.create(null);
  if (value.defines !== undefined) {
    if (!object(value.defines)) fail(`${label}.defines: expected an object with string values`);
    for (const [name, val] of Object.entries(value.defines)) {
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) || typeof val !== 'string') fail(`${label}.defines: invalid macro name or non-string value`);
      defines[name] = val;
    }
  }
  const languageMode = value.languageMode ?? 'systemverilog';
  if (languageMode !== 'verilog' && languageMode !== 'systemverilog') fail(`${label}.languageMode: expected verilog or systemverilog`);
  return { files: strings(value.files, `${label}.files`), filelists: strings(value.filelists, `${label}.filelists`),
    includeDirs: strings(value.includeDirs, `${label}.includeDirs`), defines,
    topModules: strings(value.topModules, `${label}.topModules`), languageMode };
}

/** Preserve quoting so '+' inside a quoted define value or directory is not a separator. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let token = '', quote = '';
  const flush = () => { if (token) { out.push(token); token = ''; } };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!, next = text[i + 1];
    if (c === '\\' && next !== undefined) {
      if (next === '\n') { i++; continue; }
      if (next === '\r' && text[i + 2] === '\n') { i += 2; continue; }
      token += c + next; i++; continue;
    }
    if (quote) { token += c; if (c === quote) quote = ''; continue; }
    // An apostrophe in 1'b1 / '0 is a Verilog literal, not a path quote.
    if (c === '"' || (c === "'" && (!token || token.endsWith('+')))) { quote = c; token += c; continue; }
    if ((c === '/' && next === '/') || (c === '#' && !token)) {
      flush(); while (i < text.length && text[i] !== '\n') i++; continue;
    }
    if (c === '/' && next === '*') {
      flush(); const end = text.indexOf('*/', i + 2); if (end < 0) fail('Unterminated filelist block comment'); i = end + 1; continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    token += c;
  }
  if (quote) fail('Unterminated filelist quote');
  flush();
  return out;
}
function splitPlus(token: string): string[] {
  const parts: string[] = [];
  let part = '', quote = '';
  for (let i = 0; i < token.length; i++) {
    const c = token[i]!;
    if (c === '\\' && i + 1 < token.length) { part += c + token[++i]; continue; }
    if (quote) { part += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || (c === "'" && !part)) { quote = c; part += c; continue; }
    if (c === '+') { parts.push(part); part = ''; } else part += c;
  }
  parts.push(part); return parts;
}
function unquote(token: string): string {
  let out = '', quote = '';
  for (let i = 0; i < token.length; i++) {
    const c = token[i]!;
    if (c === '\\' && i + 1 < token.length && /[\\"'\s]/.test(token[i + 1]!)) { out += token[++i]; continue; }
    if (quote) { if (c === quote) quote = ''; else out += c; continue; }
    if (c === '"' || (c === "'" && i === 0)) { quote = c; continue; }
    out += c;
  }
  if (quote) fail('Unterminated filelist quote');
  return out;
}

/** Load only a selected, explicit source profile. Invalid HDL never means "scan everything".
 * No HDL section preserves legacy behavior. Malformed overall JSON is reported separately
 * so the existing config loader can retain its policy and an indexed-profile guard can fail safely.
 */
export function loadHdlProfile(projectRoot: string): HdlProfileLoadResult {
  const result = (status: HdlProfileLoadResult['status'], diagnostics: string[] = [], profile: ActiveHdlProfile | null = null): HdlProfileLoadResult =>
    ({ status, profile, diagnostics, configInvalid: status === 'invalid-config', configPresent: present });
  let present = false;
  let root: string;
  try { root = fs.realpathSync(projectRoot); } catch { return result('invalid-config', ['HDL project root is unavailable']); }
  const contained = (candidate: string): string => {
    if (isReservedHdlPath(path.relative(root, candidate))) fail('Reserved VCS/CodeGraph paths are unsupported in HDL profiles');
    const real = fs.realpathSync(candidate);
    const rel = path.relative(root, real);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('Paths outside the project are unsupported in HDL profiles');
    if (isReservedHdlPath(rel)) fail('Reserved VCS/CodeGraph paths are unsupported in HDL profiles');
    return real;
  };
  const relative = (absolute: string) => path.relative(root, absolute).split(path.sep).join('/') || '.';
  const read = (absolute: string) => {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) fail('Config/filelist must be a regular file of at most 1 MiB');
    return fs.readFileSync(absolute, 'utf8');
  };
  let config: unknown;
  try {
    const file = path.join(root, 'codegraph.json');
    if (!fs.existsSync(file)) return result('none');
    present = true;
    config = JSON.parse(read(contained(file)));
    if (!object(config)) return result('invalid-config', ['codegraph.json: expected a JSON object']);
  } catch (error) { return result('invalid-config', [`codegraph.json could not be read: ${(error as Error).message}`]); }
  if (!Object.prototype.hasOwnProperty.call(config, 'hdl')) return result('none');
  try {
    const hdl = config.hdl;
    if (!object(hdl)) fail('codegraph.json hdl: expected an object');
    strictKeys(hdl, ['activeProfile', 'profiles'], 'hdl');
    if (typeof hdl.activeProfile !== 'string' || !hdl.activeProfile.trim()) fail('hdl.activeProfile: expected a non-empty profile name');
    if (!object(hdl.profiles) || !Object.prototype.hasOwnProperty.call(hdl.profiles, hdl.activeProfile)) fail('hdl.activeProfile does not select an existing profile');
    const selected = spec(hdl.profiles[hdl.activeProfile], `hdl.profiles.${hdl.activeProfile}`);
    const files = new Set<string>(), includeDirs = new Set<string>(), dependencies = new Map<string, string>();
    const defines: Record<string, string> = Object.assign(Object.create(null), selected.defines);
    const resolve = (name: string, base: string, directory: boolean) => {
      const real = contained(path.resolve(base, name));
      const stat = fs.statSync(real);
      if (directory ? !stat.isDirectory() : !stat.isFile()) fail(`HDL path has the wrong file type: ${relative(real)}`);
      return real;
    };
    const addFile = (name: string, base: string) => files.add(relative(resolve(name, base, false)));
    const addInclude = (name: string, base: string) => includeDirs.add(relative(resolve(name, base, true)));
    for (const file of selected.files) addFile(file, root);
    for (const directory of selected.includeDirs) addInclude(directory, root);
    let tokenCount = 0, listCount = 0;
    const stack = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string, lookupBase: string, localPaths: boolean, depth: number): void => {
      if (depth > MAX_DEPTH) fail('HDL filelist nesting exceeds 32 levels');
      const file = resolve(name, lookupBase, false), key = `${file}\0${localPaths}`;
      if (stack.has(file)) fail(`HDL filelist cycle: ${relative(file)}`);
      if (visited.has(key)) return;
      if (++listCount > MAX_LISTS) fail('HDL profile exceeds 256 filelists');
      stack.add(file); visited.add(key);
      const text = read(file), entries = tokens(text);
      dependencies.set(relative(file), hash(text));
      tokenCount += entries.length;
      if (tokenCount > MAX_TOKENS) fail('HDL profile exceeds 100000 filelist tokens');
      const base = localPaths ? path.dirname(file) : root;
      for (let i = 0; i < entries.length; i++) {
        const raw = entries[i]!, token = unquote(raw);
        if (token === '-f' || token === '-F') {
          const next = entries[++i]; if (!next) fail(`Missing argument for ${token}`);
          visit(unquote(next), base, token === '-F', depth + 1);
        } else if (raw.startsWith('+incdir+')) {
          const dirs = splitPlus(raw.slice('+incdir+'.length));
          if (dirs.some(d => !d)) fail('Empty +incdir+ entry');
          for (const directory of dirs) addInclude(unquote(directory), base);
        } else if (raw.startsWith('+define+')) {
          for (const definition of splitPlus(raw.slice('+define+'.length))) {
            const decoded = unquote(definition), eq = decoded.indexOf('=');
            const macro = eq < 0 ? decoded : decoded.slice(0, eq), value = eq < 0 ? '1' : decoded.slice(eq + 1);
            if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(macro)) fail('Invalid +define+ macro name');
            if (Object.prototype.hasOwnProperty.call(defines, macro) && defines[macro] !== value) fail(`Conflicting values for HDL macro ${macro}`);
            defines[macro] = value;
          }
        } else if (/^[+-]/.test(token)) fail(`Unsupported HDL filelist option: ${token.split('+').slice(0, 2).join('+')}`);
        else addFile(token, base);
      }
      stack.delete(file);
    };
    for (const filelist of selected.filelists) visit(filelist, root, path.extname(filelist) === '.F', 1);
    const resolved = { name: hdl.activeProfile, files: [...files], includeDirs: [...includeDirs],
      defines: Object.fromEntries(Object.entries(defines).sort(([a], [b]) => a.localeCompare(b))),
      topModules: [...new Set(selected.topModules)], languageMode: selected.languageMode,
      dependencies: [...dependencies].map(([file, sha256]) => ({ path: file, sha256 })).sort((a,b) => a.path.localeCompare(b.path)) };
    return result('active', [], { ...resolved, fingerprint: hash(JSON.stringify(resolved)) });
  } catch (error) { return result('invalid-profile', [(error as Error).message]); }
}
