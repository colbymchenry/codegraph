/**
 * FiveM (Cfx.re) resources — the registrar half of string-keyed dispatch.
 *
 * A FiveM server is a set of *resources*, each a directory with an `fxmanifest.lua`
 * (older packs: `__resource.lua`). Almost every cross-resource call is dispatched
 * through a string literal the runtime resolves at call time:
 *
 *   -- qb-inventory/server/main.lua
 *   RegisterNetEvent('qb-inventory:server:AddItem', function(item, amount) … end)
 *   exports('AddItem', function(src, item, amount) … end)
 *   lib.callback.register('qb-inventory:getStock', function(source, shop) … end)
 *
 *   -- qb-shops/client/main.lua (a different resource)
 *   TriggerServerEvent('qb-inventory:server:AddItem', item, 1)
 *   exports['qb-inventory']:AddItem(src, item, 1)
 *   local stock = lib.callback.await('qb-inventory:getStock', false, shop)
 *
 * Tree-sitter sees a call on an indexed table; nothing links the two files. Worse, the
 * handler is almost always an inline anonymous `function … end` — the extractor makes no
 * node for it, so a synthesizer alone would have nothing to point an edge at.
 *
 * This resolver's `extract()` creates that node: one `function` node per registration
 * site, named by a keyed literal — `event:<name>`, `export:<name>`, `callback:<name>`,
 * `command:<name>`, `nui:<name>` — so the dispatch
 * synthesizer (`../fivem-synthesizer.ts`) can find handlers with `getNodesByName(key)`
 * and nothing else in the graph can collide with them. `detect()` gates on a manifest
 * existing; the synthesizer resolves `exports['res']:Fn` to the `export:Fn` node under the
 * root named `res` (extraction runs in parse workers and cannot see the file list).
 *
 * Precision floor: only literal keys, only registrars with a handler argument, only
 * bare globals (a `.on(` member call is not FiveM). A repo with no manifest contributes nothing.
 */

import type { Language, Node } from '../../types';
import type { FrameworkExtractionResult, FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

const MANIFEST_RE = /(?:^|\/)(?:fxmanifest|__resource)\.lua$/;

/**
 * Resource roots — directories holding a manifest — longest-first so a nested pack resolves to
 * the innermost. Pure: computed from a file list by whoever holds one. `extract()` runs inside
 * parse workers that only receive framework *names*, so nothing here may depend on state
 * `detect()` set on the main thread; the synthesizer recomputes roots from `ctx.getAllFiles()`.
 */
export function fivemResourceRootsFrom(files: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const f of files) {
    if (MANIFEST_RE.test(f)) roots.add(f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

/** The resource a file belongs to — its root's basename — or null when outside every root. */
export function fivemResourceOf(filePath: string, roots: readonly string[]): { root: string; name: string } | null {
  for (const root of roots) {
    if (root === '' || filePath.startsWith(root + '/')) {
      return { root, name: root === '' ? '' : root.slice(root.lastIndexOf('/') + 1) };
    }
  }
  return null;
}

/**
 * NUI (browser) code — `html/`, `web/`, `ui/`, `nui/` trees and minified bundles. No FiveM global
 * exists there, so nothing in it registers a handler (`on('hook:destroyed')` in vue.min.js is Vue),
 * and its only dispatch into the resource is `fetch('https://<resource>/<name>')`.
 */
export function isFivemNuiFile(filePath: string): boolean {
  return /(?:^|\/)(?:html|web|ui|nui)\//i.test(filePath) || /\.min\.[cm]?js$/i.test(filePath);
}

export function fivemLanguageFor(filePath: string): Language | null {
  if (/\.luau$/i.test(filePath)) return 'luau';
  if (/\.lua$/i.test(filePath)) return 'lua';
  if (/\.(?:ts|mts|cts)$/i.test(filePath)) return 'typescript';
  if (/\.(?:js|mjs|cjs)$/i.test(filePath)) return 'javascript';
  return null;
}

/**
 * Blank out Lua comments (`--` and `--[[ … ]]` / `--[==[ … ]==]`) with spaces, keeping every
 * newline so line numbers survive. Strings and long strings are skipped, not stripped.
 * `strip-comments.ts` has no Lua dialect; this is the minimum it would need.
 */
export function stripLuaComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) { out += src[i]! + src[i + 1]!; i += 2; continue; }
        out += src[i]!;
        i++;
      }
      if (i < n && src[i] === q) { out += q; i++; }
      continue;
    }
    const longOpen = c === '[' ? /^\[(=*)\[/.exec(src.slice(i, i + 32)) : null;
    if (longOpen) {
      const close = `]${longOpen[1]}]`;
      const end = src.indexOf(close, i + longOpen[0].length);
      const stop = end === -1 ? n : end + close.length;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      const block = /^--\[(=*)\[/.exec(src.slice(i, i + 32));
      let stop: number;
      if (block) {
        const close = `]${block[1]}]`;
        const end = src.indexOf(close, i + block[0].length);
        stop = end === -1 ? n : end + close.length;
      } else {
        const nl = src.indexOf('\n', i);
        stop = nl === -1 ? n : nl;
      }
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function stripForFivem(content: string, language: Language): string {
  if (language === 'lua' || language === 'luau') return stripLuaComments(content);
  return stripCommentsForRegex(content, language === 'javascript' ? 'javascript' : 'typescript');
}

// ── handler extent ────────────────────────────────────────────────────────────
// The registrar's handler argument is almost always an inline function. Its extent is what
// lets a dispatch *inside* the handler be attributed to the handler node (the chain
// `export AddItem → event AddItem` is the one card mining wants). Source is comment-stripped
// already; strings are skipped here. A named handler (`RegisterNetEvent('x', OnX)`) has no
// body at the site — its extent is the line.

const LUA_WORD = /\b(function|if|do|repeat|until|end)\b|(['"])/g;

/** Line of the `end` closing the `function` that begins at/after `from`, or null when the arg is not an inline function. */
function luaHandlerEnd(src: string, from: number): number | null {
  const head = /^\s*,\s*(function\b)/.exec(src.slice(from, from + 64));
  if (!head) return null;
  let i = from + head.index + head[0].length - head[1]!.length; // at `function`
  let depth = 0;
  LUA_WORD.lastIndex = i;
  let m: RegExpExecArray | null;
  while ((m = LUA_WORD.exec(src))) {
    if (m[2]) { // skip a short string
      const q = m[2];
      let j = m.index + 1;
      while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      LUA_WORD.lastIndex = j + 1;
      continue;
    }
    const w = m[1]!;
    if (w === 'function' || w === 'if' || w === 'do' || w === 'repeat') depth++;
    else if (w === 'end' || w === 'until') depth--;
    if (depth === 0) return src.slice(0, m.index).split('\n').length;
  }
  return null;
}

/** Line of the `}` closing the arrow/function handler that begins at/after `from`, or null. */
function jsHandlerEnd(src: string, from: number): number | null {
  const head = /^\s*,\s*(?:async\s*)?(?:function\b[^{]*|\([^)]*\)\s*=>\s*|[A-Za-z_$][\w$]*\s*=>\s*)\{/.exec(src.slice(from, from + 200));
  if (!head) return null;
  let i = from + head[0].length; // just past the opening `{`
  let depth = 1;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(0, i).split('\n').length;
  }
  return null;
}

// ── registrars ────────────────────────────────────────────────────────────────
// Each yields (keyKind, literal) at a site that supplies a handler. `RegisterNetEvent('x')`
// with no handler is a declaration, not a handler — the handler is the `AddEventHandler`
// that follows, and that one matches.
interface RegistrarSpec {
  re: RegExp;
  key: (m: RegExpExecArray) => string;
}
const Q = `(['"\`])`;
const LIT = `([^'"\`\\n]+)`;
/** Not preceded by `.`/`:`/word — `socket.on(`, `emitter.emit(`, `obj:TriggerEvent(` are somebody's methods, not FiveM globals. */
const G = `(?<![\\w.:])`;
// `export:`/`nui:` keys carry only the exported name here — the resource is a property of the
// file's location, which only the synthesizer (with the file list) can resolve.
const REGISTRARS: RegistrarSpec[] = [
  { re: new RegExp(`${G}(?:RegisterNetEvent|AddEventHandler|RegisterServerEvent|onNet|on)\\s*\\(\\s*${Q}${LIT}\\1\\s*,`, 'g'), key: (m) => `event:${m[2]}` },
  { re: new RegExp(`${G}exports\\s*\\(\\s*${Q}${LIT}\\1\\s*,`, 'g'), key: (m) => `export:${m[2]}` },
  { re: new RegExp(`${G}(?:lib\\.callback\\.register|QBCore\\.Functions\\.CreateCallback)\\s*\\(\\s*${Q}${LIT}\\1\\s*,`, 'g'), key: (m) => `callback:${m[2]}` },
  { re: new RegExp(`${G}RegisterCommand\\s*\\(\\s*${Q}${LIT}\\1\\s*,`, 'g'), key: (m) => `command:${m[2]}` },
  { re: new RegExp(`${G}RegisterNUICallback\\s*\\(\\s*${Q}${LIT}\\1\\s*,`, 'g'), key: (m) => `nui:${m[2]}` },
];

export const FIVEM_NODE_PREFIX = 'fivem:';

export const fivemResolver: FrameworkResolver = {
  name: 'fivem',
  languages: ['lua', 'luau', 'javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    return fivemResourceRootsFrom(context.getAllFiles()).length > 0;
  },

  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null; // bridging is the synthesizer's job — it needs the whole graph, not one ref
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const none: FrameworkExtractionResult = { nodes: [], references: [] };
    const language = fivemLanguageFor(filePath);
    if (!language || isFivemNuiFile(filePath)) return none;
    const src = stripForFivem(content, language);
    const nodes: Node[] = [];
    const seen = new Set<string>();
    const lines = src.split('\n');
    for (const spec of REGISTRARS) {
      spec.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = spec.re.exec(src))) {
        const key = spec.key(m);
        const line = src.slice(0, m.index).split('\n').length;
        const afterKey = m.index + m[0].length - 1; // at the `,` following the literal
        const endLine = (language === 'lua' || language === 'luau' ? luaHandlerEnd(src, afterKey) : jsHandlerEnd(src, afterKey)) ?? line;
        const qualifiedName = `${filePath}::${key}@${line}`;
        if (seen.has(qualifiedName)) continue;
        seen.add(qualifiedName);
        nodes.push({
          id: `${FIVEM_NODE_PREFIX}${qualifiedName}`,
          kind: 'function',
          name: key,
          qualifiedName,
          filePath,
          language,
          startLine: line,
          endLine,
          startColumn: 0,
          endColumn: 0,
          signature: (lines[line - 1] ?? '').trim().slice(0, 160),
          isExported: true,
          updatedAt: Date.now(),
        });
      }
    }
    return { nodes, references: [] };
  },
};
