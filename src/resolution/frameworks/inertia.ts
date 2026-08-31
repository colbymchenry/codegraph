/**
 * Inertia prop-boundary resolver.
 *
 * Inertia (Laravel, Rails, Phoenix) renders a page by handing a server-side
 * PROP MAP to a client component. There is no REST schema and no GraphQL
 * document: the contract IS that map, and it is written twice — once as the
 * server map, once as a client destructure or type. Nothing in either half
 * references the other, so the boundary is invisible to a graph built from
 * calls and imports, and three ordinary questions have no answer:
 *
 *   - this prop is emitted — is it read anywhere? (a dead prop costs a query
 *     and payload on every render)
 *   - this prop is read — is it still emitted? (renders as undefined, silently)
 *   - I am renaming this prop — what else must change in the same commit?
 *
 * Worse, when the server camelizes its keys the two halves do not even share a
 * spelling: the server emits `user_display_name` and the client reads
 * `userDisplayName`, so a grep for either finds exactly one side. That is what
 * makes this a resolver problem rather than something search can answer.
 *
 * NO CONFIGURATION, AND NO GLOBAL STATE. Rather than read the adapter's
 * camelize setting out of project config — which would have to be discovered
 * once and then carried into per-file extraction — a prop carries BOTH candidate
 * spellings and the consumer scan records which one actually matched. That
 * works unchanged for Laravel and Rails (verbatim keys) and for Phoenix with
 * `camelize_props: true`, and it cannot silently mis-link if a project's
 * setting is not what we assumed.
 */

import { FrameworkResolver, FrameworkExtractionResult, ResolutionContext } from '../types';
import type { Node } from '../../types';
import { detectLanguage } from '../../extraction/grammars';
import { stripCommentsForRegex, type CommentLang } from '../strip-comments';
import { phoenixCamelizeLower, stripPreserveCase } from '../inertia-props';

/** Marks a node this resolver created, and carries the page it belongs to. */
export const INERTIA_PROP_MARKER = 'inertia-prop';

/** Server files that can hold a render call, by extension. */
function serverLang(filePath: string): CommentLang | null {
  if (/\.php$/i.test(filePath)) return 'php';
  if (/\.rb$/i.test(filePath)) return 'ruby';
  // Elixir has no comment-stripper entry; `#` line comments match ruby's.
  if (/\.exs?$/i.test(filePath)) return 'ruby';
  return null;
}

/**
 * The render calls each adapter spells, reduced to "page name" + "prop map
 * text". Only a LITERAL page name is usable — a computed one names no
 * component we could find.
 */
const RENDER_PATTERNS: RegExp[] = [
  // Laravel: Inertia::render('Page/Name', [ ... ]) / inertia('Page', [ ... ])
  /(?:Inertia::render|inertia)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\[)/g,
  // Rails: render inertia: 'Page/Name', props: { ... }
  /render\s+inertia:\s*['"]([^'"]+)['"]\s*,\s*props:\s*(\{)/g,
  // Phoenix: render_inertia(conn, "Page/Name", %{ ... })
  /render_inertia\s*\([^,]+,\s*['"]([^'"]+)['"]\s*,\s*(%\{|\{)/g,
];

/** Balanced-delimiter slice starting at `open`, so a nested map does not truncate it. */
function balancedSlice(text: string, open: number): string {
  const opener = text[open]!;
  const closer = opener === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/**
 * The prop keys a map literal declares, in source order.
 *
 * Only literal keys are read, and that is a correctness requirement rather than
 * a simplification: an adapter transforms EVERY map key at every depth, with no
 * distinction between a schema key and a DATA key — a map keyed by a
 * user-supplied name is camelized exactly like a field name. A computed key is
 * therefore a dynamic edge, and inventing a name for it would produce a
 * confident wrong link. Nested maps are skipped for the same reason: their keys
 * are frequently data.
 */
export function propKeysFromMap(mapText: string): Array<{ key: string; preserved: boolean; offset: number }> {
  const out: Array<{ key: string; preserved: boolean; offset: number }> = [];
  // Only scan the TOP level of the map — depth tracking keeps a nested literal
  // (often a data-keyed collection) from contributing phantom prop names.
  let depth = 0;
  const keyRe = /(?:^|[,{[\s])\s*(?:(['"])([\w]+)\1\s*(?:=>|:)|([\w]+):(?!:)|:([\w]+)\s*=>|(preserve_case\([^)]*\))\s*(?:=>|:))/g;
  // Only collection delimiters nest. Parentheses are NOT counted: they appear
  // in ordinary values (`total: sum(x)`) and in a key expression itself
  // (`preserve_case(:K) => v`), so treating them as depth would split the
  // top-level scan and drop real keys.
  const opens = new Set(['{', '[']);
  const closes = new Set(['}', ']']);
  const topLevelRanges: Array<[number, number]> = [];
  let rangeStart = 0;
  for (let i = 0; i < mapText.length; i++) {
    const ch = mapText[i]!;
    if (opens.has(ch)) {
      depth++;
      if (depth === 1) rangeStart = i;
      else if (depth === 2) topLevelRanges.push([rangeStart, i]);
    } else if (closes.has(ch)) {
      if (depth === 2) rangeStart = i + 1;
      depth--;
      if (depth === 0) topLevelRanges.push([rangeStart, i]);
    }
  }
  for (const [from, to] of topLevelRanges) {
    const segment = mapText.slice(from, to);
    keyRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(segment)) !== null) {
      const raw = m[2] ?? m[3] ?? m[4] ?? m[5];
      if (!raw) continue;
      const { key, preserved } = stripPreserveCase(raw);
      if (!key) continue;
      out.push({ key, preserved, offset: from + m.index });
    }
  }
  return out;
}

/** Both spellings a client could be using for one server key. */
export function clientCandidates(key: string, preserved: boolean): string[] {
  if (preserved) return [key];
  const camel = phoenixCamelizeLower(key);
  return camel && camel !== key ? [key, camel] : [key];
}

/** Signals that a project uses Inertia at all. */
function usesInertia(context: ResolutionContext): boolean {
  for (const manifest of ['package.json', 'composer.json', 'Gemfile', 'mix.exs']) {
    const content = context.readFile(manifest);
    if (content && /inertia/i.test(content)) return true;
  }
  return false;
}

export const inertiaResolver: FrameworkResolver = {
  name: 'inertia',
  // Deliberately unrestricted: the render call may be PHP, Ruby or Elixir, and
  // the page component TSX / Vue / Svelte. `extract` gates by extension.
  detect(context) {
    return usesInertia(context);
  },

  // Nothing name-based to resolve — the boundary is closed by the synthesis
  // pass, which needs whole-graph knowledge (page components, symbol ranges).
  resolve() {
    return null;
  },

  extract(filePath, content): FrameworkExtractionResult {
    const lang = serverLang(filePath);
    if (!lang) return { nodes: [], references: [] };
    if (!/render_inertia|Inertia::render|inertia:|inertia\s*\(/.test(content)) {
      return { nodes: [], references: [] };
    }

    const nodes: Node[] = [];
    const safe = stripCommentsForRegex(content, lang);
    const now = Date.now();
    const fileLang = detectLanguage(filePath);

    for (const pattern of RENDER_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(safe)) !== null) {
        const page = match[1]!;
        const mapOpen = safe.indexOf(match[2]!, match.index + match[0].length - match[2]!.length);
        if (mapOpen < 0) continue;
        // `%{` opens at the brace, not the percent.
        const braceAt = safe[mapOpen] === '%' ? mapOpen + 1 : mapOpen;
        const mapText = balancedSlice(safe, braceAt);
        for (const { key, preserved, offset } of propKeysFromMap(mapText)) {
          const absolute = braceAt + offset;
          const line = safe.slice(0, absolute).split('\n').length;
          nodes.push({
            id: `inertia-prop:${filePath}:${line}:${page}:${key}`,
            kind: 'property',
            // Named by what the SERVER wrote — that is the name someone
            // renaming the prop is looking at. The client spelling(s) live in
            // the signature, where both halves of the contract are visible at
            // once.
            name: key,
            qualifiedName: `${page}.${key}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: 0,
            language: fileLang,
            signature: `${key} → ${clientCandidates(key, preserved).join(' | ')}`,
            decorators: [
              INERTIA_PROP_MARKER,
              `page=${page}`,
              ...(preserved ? ['preserve_case'] : []),
            ],
            updatedAt: now,
          });
        }
      }
    }
    return { nodes, references: [] };
  },
};
