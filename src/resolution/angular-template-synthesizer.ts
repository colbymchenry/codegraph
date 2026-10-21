/**
 * Angular templates: what a component renders and where it links.
 *
 * An Angular component's markup is a template — a `templateUrl` file beside
 * it, or an inline `template:` string — that the index never parses, so four
 * things a reader relies on were missing from the graph:
 *
 * - **The component tree.** `<app-article-list [config]="listConfig">` in the
 *   home page's template renders `ArticleListComponent`, and the
 *   `<app-favorite-button>` inside that renders the button whose click
 *   navigates. Without the edge, a navigation in a child component reached no
 *   screen. A `calls` edge from the parent class to the child class
 *   (`synthesizedBy: 'angular-template'`) stands for the render, the way
 *   `jsx-render` does for a React child.
 * - **`routerLink`.** `routerLink="/login"`, `routerLink="/profile/{{ name }}"`,
 *   `[routerLink]="['/article', article.slug]"`, and a bound property that
 *   holds a route constant (`[routerLink]="routerLinkAbout"` with
 *   `routerLinkAbout = publicRoutes.about.routerLink`) each become a
 *   `navigates` edge from the component to the route it names.
 *
 * - **Event bindings.** `(click)="toggleFavorite()"` is the only caller a
 *   handler method has. A `calls` edge from the component to its own method
 *   (`synthesizedBy: 'angular-event'`) carries the binding as its
 *   `trigger`, the label Steps puts on the hop — read from the template, so
 *   it cannot be read back from the source at the edge's line.
 * - **Bindings.** `[name]="icon()"`, `{{ label() }}`, `*ngIf="isOpen()"` and
 *   `@if (loading()) {` call the component's own members at every render —
 *   with signals (`icon = computed(…)`), the usual way a template reads
 *   state, and often a member's only caller. Each is a `calls` edge
 *   (`synthesizedBy: 'angular-binding'`, the binding as `via`) WITHOUT a
 *   trigger: the call runs when the template renders, not when a user acts,
 *   the way a JSX attribute's `name={icon()}` carries none. Reading a member
 *   without calling it counts only when the member is method-kind: a getter
 *   (`[disabled]="!canSave"`) runs, so it is called; a method handed to a
 *   child (`[displayWith]="displayFn"`, `trackBy: trackById`) is a function
 *   reference (`references`, `fnRef`), as `this.handler` passed as an
 *   argument is in TypeScript; a field a call filled (`days =
 *   Array.from(…)`) is a plain `references`. A property read
 *   (`[value]="title"`) links nothing — TypeScript records no property reads
 *   either, and the dead-code list does not ask about properties.
 *
 * A child is matched by its element selector (`selector: 'app-article-list'`),
 * in the same app first; a selector two components share there is left
 * unmatched. A relative link and a destination no route serves draw nothing.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { isTestPath } from '../search/query-utils';
import { stripCommentsForRegex } from './strip-comments';
import { matchBracket, readFields, skipString } from './frameworks/object-literal';
import { dependsOn } from './frameworks/package-deps';
import { appRootFor, HOLE, toHref, type HrefLiteral } from './frameworks/expo-router';
import { destinationsForHref } from './frameworks/nextjs';
import { angularDestination, angularRouteTable, angularRoutesFor, namesSomewhere, staticString, templatePathFor } from './frameworks/angular-router';

interface AngularComponent {
  node: Node;
  file: string;
  selectors: string[];
  template: { file: string; text: string; firstLine: number; inline: boolean } | null;
}

/** Links a single component may carry before it is a navigation menu rather than a decision. */
const MAX_LINKS_PER_COMPONENT = 24;
/** Children a single template may render before the rest are left out. */
const MAX_CHILDREN_PER_COMPONENT = 40;

/** An element selector: `app-article-list`, not `[appDirective]` or `button[app-x]`. */
const ELEMENT_SELECTOR = /^[a-zA-Z][\w-]*$/;

const lineOfOffset = (text: string, at: number): number => {
  let line = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** Every `@Component` class a file declares, with its selectors and template. */
function componentsIn(file: string, content: string, nodes: readonly Node[], ctx: ResolutionContext): AngularComponent[] {
  const out: AngularComponent[] = [];
  const safe = stripCommentsForRegex(content, 'typescript');
  const decorator = /@Component\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = decorator.exec(safe)) !== null) {
    const paren = m.index + m[0].length - 1;
    const close = matchBracket(safe, paren);
    if (close < 0) continue;
    decorator.lastIndex = close;
    const open = safe.indexOf('{', paren);
    if (open < 0 || open > close) continue;
    const objEnd = matchBracket(safe, open);
    if (objEnd < 0) continue;
    const cls = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(safe.slice(close + 1, close + 400));
    if (!cls) continue;
    const node = nodes.find((n) => n.kind === 'class' && n.name === cls[1]);
    if (!node) continue;
    const fields = readFields(safe, open, objEnd);
    const selectorText = fields.get('selector')?.text;
    const selector = selectorText ? staticString(selectorText) : null;
    const selectors = (selector ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => ELEMENT_SELECTOR.test(s));

    let template: AngularComponent['template'] = null;
    const url = fields.get('templateUrl')?.text;
    const templateUrl = url ? staticString(url) : null;
    if (templateUrl) {
      const templateFile = templatePathFor(file, templateUrl);
      const text = ctx.readFile(templateFile);
      if (text) template = { file: templateFile, text, firstLine: 1, inline: false };
    } else {
      const inline = fields.get('template');
      if (inline) {
        // The template string's body, from the original source (stripping
        // comments must not touch a template's text), at its own offset.
        const quoteAt = content.indexOf(inline.text.trim()[0] ?? '`', inline.at + 'template'.length);
        const end = quoteAt < 0 ? -1 : skipString(content, quoteAt);
        if (end > quoteAt) {
          template = { file, text: content.slice(quoteAt + 1, end), firstLine: lineOfOffset(content, quoteAt + 1), inline: true };
        }
      }
    }
    out.push({ node, file, selectors, template });
  }
  return out;
}

/** Per context, renewed with the route list (whose identity changes when the resolver's caches do). */
const componentIndexes = new WeakMap<ResolutionContext, { source: readonly Node[]; components: AngularComponent[] }>();

/** Every component in the project, read once per resolution state. */
export function angularComponents(ctx: ResolutionContext): AngularComponent[] {
  const source = ctx.getNodesByKind('route');
  const hit = componentIndexes.get(ctx);
  if (hit && hit.source === source) return hit.components;
  const components: AngularComponent[] = [];
  for (const file of ctx.getAllFiles()) {
    if (!/\.[cm]?ts$/.test(file) || file.endsWith('.d.ts') || isTestPath(file)) continue;
    if (!(ctx.fileContains?.(file, '@Component') ?? ctx.readFile(file)?.includes('@Component'))) continue;
    const content = ctx.readFile(file);
    if (!content) continue;
    components.push(...componentsIn(file, content, ctx.getNodesInFile(file), ctx));
  }
  componentIndexes.set(ctx, { source, components });
  return components;
}

// =============================================================================
// Reading a template
// =============================================================================

/** `routerLink="…"` (plain) and `[routerLink]="…"` (bound), either quote. `routerLinkActive` is neither. */
const ROUTER_LINK = /(\[routerLink\]|\brouterLink)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** `(click)="save()"` / `(ngSubmit)="submitForm()"` — an event binding, not `[(ngModel)]`'s two-way half. */
const EVENT_BINDING = /(?<!\[)\(([A-Za-z][\w.-]*)\)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** A call a template statement makes on its component: `save()`, `this.toggle(item)` — not `form.reset()`. */
const OWN_CALL = /(?<![\w$.])(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;

/** The element a binding at `at` is written on: the last opening tag before it. */
function elementAt(text: string, at: number): string | null {
  const open = text.lastIndexOf('<', at);
  if (open < 0) return null;
  const tag = /^<([a-zA-Z][\w-]*)/.exec(text.slice(open, open + 64));
  return tag ? tag[1]! : null;
}

/** A `routerLink:` field of an object literal written in a class. */
const ROUTER_LINK_FIELD = /(?<![\w$.])routerLink\s*:\s*/g;

/** An object field's value text from `at`, up to its `,` or closing brace at depth 0. */
function fieldValue(text: string, at: number): string | null {
  let i = at;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (ch === '[' || ch === '{' || ch === '(') {
      const end = matchBracket(text, i);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (ch === ',' || ch === '}' || ch === ']' || ch === ')' || ch === ';') break;
    i++;
  }
  return text.slice(at, i).trim() || null;
}

/** An opening tag's name. */
const TAG = /<([a-zA-Z][\w-]*)(?=[\s/>])/g;

/** The destination a plain `routerLink` names: `/profile/{{ user.username }}` is `/profile/${…}`. */
function plainHref(value: string): HrefLiteral | null {
  const withHoles = value.trim().replace(/\{\{[\s\S]*?\}\}/g, HOLE);
  return withHoles.startsWith('/') ? namesSomewhere(toHref(withHoles)) : null;
}

// =============================================================================
// What a template reads at render
// =============================================================================

/** `[name]="…"`, `[attr.aria-label]="…"`, `[class.done]="…"`, `[(ngModel)]="…"`: a binding whose value is an expression. */
const PROPERTY_BINDING = /\[(\([A-Za-z][\w.-]*\)|[A-Za-z@][\w.@-]*)\]\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** `*ngIf="…"`, `*ngFor="let item of items; trackBy: trackById"`: a structural directive, in its microsyntax. */
const STRUCTURAL_DIRECTIVE = /(?<![\w$*-])\*([A-Za-z][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** `{{ … }}`, in text or inside an attribute's value. */
const INTERPOLATION = /\{\{([\s\S]*?)\}\}/g;
/** A control-flow block that takes an expression: `@if (…) {`, `@else if (…)`, `@for (…)`, `@switch (…)`, `@case (…)`, `@defer (…)`. */
const CONTROL_FLOW = /(?<![\w$@])@(if|else\s+if|for|switch|case|defer)\s*\(/g;
/** `@let total = price() * quantity();` — a template's own constant. */
const LET_DECLARATION = /(?<![\w$@])@let\s+([A-Za-z_$][\w$]*)\s*=/g;
/** A template reference variable — `#nameInput`, `ref-nameInput` — which the whole template sees. */
const REFERENCE_VARIABLE = /(?<=\s)(?:#|ref-)([A-Za-z_$][\w$]*)(?=[\s=/>])/g;
/** `let-row`, `let-i="index"` on an `<ng-template>`: a local of what it renders. */
const TEMPLATE_INPUT = /(?<=\s)let-([A-Za-z_$][\w$]*)(?=[\s=/>])/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/** A name an expression writes: `this.` may lead it; a member of something else (`form.reset`) is not one. */
const EXPRESSION_NAME = /(?<![\w$.])(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)/g;
const NAME_AT = /[A-Za-z_$][\w$]*/y;

/** A name a template expression calls (`icon()`) or only reads (`canSave`, `displayFn`). */
export interface TemplateMemberUse {
  name: string;
  /** Offset of the name in the template. */
  at: number;
  call: boolean;
  /** The binding the expression belongs to, as written: `[name]`, `{{ }}`, `*ngIf`, `@if`, `@let`. */
  via: string;
}

/**
 * One expression, and the scope it is read in. `scope` is the directive or
 * block that evaluates it — the locals that scope declares are visible to it
 * only where Angular says so (`@for`'s `track` sees the loop variable; the
 * `@if` condition does not see its own `as` alias).
 */
interface TemplateExpression {
  via: string;
  at: number;
  text: string;
  scope: number;
  seesOwnLocals: boolean;
}

/** A name the template declares — a local, never the component's member. Visible from `from` on. */
interface TemplateLocal {
  name: string;
  from: number;
  /** The directive or block that declared it; -1 for a reference variable or a `let-` input. */
  scope: number;
}

/**
 * Each string literal blanked to spaces, so a quoted `'save()'` names nothing
 * and offsets survive. A template literal keeps its `${…}` holes: they are
 * expressions (`isToday(\`${key}-${formatDay(day)}\`)`).
 */
function blankStrings(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      const close = end < 0 ? text.length : end + 1;
      out += ' '.repeat(close - i);
      i = close;
    } else if (ch === '`') {
      out += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === '`') {
          out += ' ';
          i++;
          break;
        }
        const close = text[i] === '$' && text[i + 1] === '{' ? matchBracket(text, i + 1) : -1;
        if (close >= 0) {
          out += `  ${blankStrings(text.slice(i + 2, close))} `;
          i = close + 1;
          continue;
        }
        const step = text[i] === '\\' ? Math.min(2, text.length - i) : 1;
        out += ' '.repeat(step);
        i += step;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const isBlank = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/** The names an expression calls or reads, minus a pipe's name and an object literal's keys. */
function expressionUses(expression: string): Array<{ name: string; at: number; call: boolean }> {
  const text = blankStrings(expression);
  const out: Array<{ name: string; at: number; call: boolean }> = [];
  EXPRESSION_NAME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPRESSION_NAME.exec(text)) !== null) {
    const name = m[1]!;
    const end = m.index + m[0].length;
    let before = m.index - 1;
    while (isBlank(text[before])) before--;
    let after = end;
    while (isBlank(text[after])) after++;
    const prev = text[before];
    const next = text[after];
    // `form .reset()`: a member of something else, however it is spaced.
    if (prev === '.') continue;
    // A pipe's name: `total | currency: code()` — but `a || b` is no pipe.
    if (prev === '|' && text[before - 1] !== '|') continue;
    // An object literal's key: `[ngClass]="{ active: isActive() }"`.
    if ((prev === '{' || prev === ',') && next === ':') continue;
    out.push({ name, at: end - name.length, call: next === '(' });
  }
  return out;
}

/**
 * Where the expression starting at `from` ends: a `;` or `,` outside any
 * bracket, or the words `as` / `let` that open the next microsyntax binding.
 */
function expressionEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i);
      if (end < 0) return text.length;
      i = end;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && (ch === ';' || ch === ',')) return i;
    else if (depth === 0 && isBlank(text[i - 1]) && /^(?:as|let)(?![\w$])/.test(text.slice(i, i + 4))) return i;
  }
  return text.length;
}

/** `text` split at each `;` outside brackets and strings, with each part's offset. */
function topLevelParts(text: string): Array<{ at: number; text: string }> {
  const parts: Array<{ at: number; text: string }> = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) {
      parts.push({ at: start, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  parts.push({ at: start, text: text.slice(start) });
  return parts;
}

/**
 * A structural directive's microsyntax, read into the expressions it
 * evaluates and the locals it declares: `let item of items; let i = index;
 * trackBy: trackById` evaluates `items` and `trackById` and declares `item`
 * and `i`. A key (`of`, `trackBy:`, `else`) and the context name a binding
 * takes (`index`, `index as i`) belong to the directive, never the component.
 */
export function readMicrosyntax(text: string): { expressions: Array<{ at: number; text: string }>; locals: string[] } {
  const expressions: Array<{ at: number; text: string }> = [];
  const locals: string[] = [];
  let i = 0;
  const skip = (separators: boolean) => {
    while (i < text.length && (isBlank(text[i]) || (separators && (text[i] === ';' || text[i] === ',')))) i++;
  };
  const word = (): string | null => {
    NAME_AT.lastIndex = i;
    const m = NAME_AT.exec(text);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  let first = true;
  while (i < text.length) {
    skip(true);
    if (i >= text.length) break;
    const start = i;
    const key = word();
    if (key === 'let' && isBlank(text[i])) {
      // `let item`, `let i = index`: a local, and the context name it takes.
      skip(false);
      const local = word();
      if (local) locals.push(local);
      skip(false);
      if (text[i] === '=') {
        i++;
        skip(false);
        word();
      }
      first = false;
      continue;
    }
    if (first || key === null) {
      // The directive's own expression (`*ngIf="cond"`) has no key.
      i = start;
    } else {
      skip(false);
      if (text[i] === ':') i++;
      skip(false);
    }
    const end = expressionEnd(text, i);
    if (end > i) expressions.push({ at: i, text: text.slice(i, end) });
    i = end;
    skip(false);
    if (/^as(?![\w$])/.test(text.slice(i, i + 3))) {
      i += 2;
      skip(false);
      const alias = word();
      if (alias) locals.push(alias);
    }
    // Nothing read (a stray character): step past it.
    if (i === start) i++;
    first = false;
  }
  return { expressions, locals };
}

/** The `;` that ends a `@let` declaration's expression, or -1. */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (--depth < 0) return -1;
    } else if (ch === ';' && depth === 0) return i;
  }
  return -1;
}

/**
 * Every name a template's bindings call or read at render — property
 * bindings, interpolations, structural directives, control flow and `@let` —
 * in template order, minus what the template names itself: a pipe, an object
 * key, a microsyntax key, and any local it declares (`let item`, `as user`,
 * `#input`, `@let total`). Event bindings are not here: they run when the
 * user acts, and are read on their own. A commented-out binding reads nothing.
 */
export function templateMemberUses(template: string): TemplateMemberUse[] {
  const text = template.replace(HTML_COMMENT, (c) => c.replace(/[^\n]/g, ' '));
  const expressions: TemplateExpression[] = [];
  const locals: TemplateLocal[] = [];
  let scope = 0;
  const valueAt = (m: RegExpExecArray, value: string) => m.index + m[0].length - 1 - value.length;
  const tagStart = (at: number) => Math.max(0, text.lastIndexOf('<', at));

  PROPERTY_BINDING.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROPERTY_BINDING.exec(text)) !== null) {
    const value = m[2] ?? m[3] ?? '';
    expressions.push({ via: `[${m[1]!}]`, at: valueAt(m, value), text: value, scope: ++scope, seesOwnLocals: false });
  }
  STRUCTURAL_DIRECTIVE.lastIndex = 0;
  while ((m = STRUCTURAL_DIRECTIVE.exec(text)) !== null) {
    const value = m[2] ?? m[3] ?? '';
    const at = valueAt(m, value);
    const own = ++scope;
    const read = readMicrosyntax(value);
    for (const e of read.expressions) expressions.push({ via: `*${m[1]!}`, at: at + e.at, text: e.text, scope: own, seesOwnLocals: false });
    // The host element and everything inside it see the directive's locals.
    for (const name of read.locals) locals.push({ name, from: tagStart(m.index), scope: own });
  }
  INTERPOLATION.lastIndex = 0;
  while ((m = INTERPOLATION.exec(text)) !== null) {
    expressions.push({ via: '{{ }}', at: m.index + 2, text: m[1]!, scope: ++scope, seesOwnLocals: false });
  }
  CONTROL_FLOW.lastIndex = 0;
  while ((m = CONTROL_FLOW.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close < 0) continue;
    const kind = m[1]!.replace(/\s+/g, ' ');
    const via = `@${kind}`;
    const own = ++scope;
    const parts = topLevelParts(text.slice(open + 1, close)).map((p) => ({ at: open + 1 + p.at, text: p.text }));
    if (kind === 'switch' || kind === 'case') {
      for (const p of parts) expressions.push({ via, at: p.at, text: p.text, scope: own, seesOwnLocals: false });
    } else if (kind === 'defer') {
      // `when cond` is an expression; `on viewport`, `on timer(5s)` are triggers.
      for (const p of parts) {
        const when = /^\s*(?:(?:prefetch|hydrate)\s+)?when(?![\w$])/.exec(p.text);
        if (when) expressions.push({ via, at: p.at + when[0].length, text: p.text.slice(when[0].length), scope: own, seesOwnLocals: false });
      }
    } else if (kind === 'for') {
      // `item of items(); track item.id; let i = $index, odd = $odd`
      const [head, ...rest] = parts;
      const loop = head ? /^(\s*)([A-Za-z_$][\w$]*)\s+of(?![\w$])/.exec(head.text) : null;
      if (head && loop) {
        locals.push({ name: loop[2]!, from: m.index, scope: own });
        expressions.push({ via, at: head.at + loop[0].length, text: head.text.slice(loop[0].length), scope: own, seesOwnLocals: false });
      }
      for (const p of rest) {
        const track = /^\s*track(?![\w$])/.exec(p.text);
        if (track) {
          expressions.push({ via, at: p.at + track[0].length, text: p.text.slice(track[0].length), scope: own, seesOwnLocals: true });
          continue;
        }
        if (/^\s*let(?![\w$])/.test(p.text)) {
          for (const alias of p.text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*\$?[\w$]+/g)) locals.push({ name: alias[1]!, from: m.index, scope: own });
        }
      }
    } else {
      // `@if (user(); as user)`: the condition, then the alias its body sees.
      const [head, ...rest] = parts;
      if (head) expressions.push({ via, at: head.at, text: head.text, scope: own, seesOwnLocals: false });
      for (const p of rest) {
        const alias = /^\s*as\s+([A-Za-z_$][\w$]*)/.exec(p.text);
        if (alias) locals.push({ name: alias[1]!, from: m.index, scope: own });
      }
    }
  }
  LET_DECLARATION.lastIndex = 0;
  while ((m = LET_DECLARATION.exec(text)) !== null) {
    const at = m.index + m[0].length;
    const end = statementEnd(text, at);
    if (end < 0) continue;
    const own = ++scope;
    expressions.push({ via: '@let', at, text: text.slice(at, end), scope: own, seesOwnLocals: false });
    locals.push({ name: m[1]!, from: m.index, scope: own });
  }
  REFERENCE_VARIABLE.lastIndex = 0;
  while ((m = REFERENCE_VARIABLE.exec(text)) !== null) locals.push({ name: m[1]!, from: 0, scope: -1 });
  TEMPLATE_INPUT.lastIndex = 0;
  while ((m = TEMPLATE_INPUT.exec(text)) !== null) locals.push({ name: m[1]!, from: tagStart(m.index), scope: -1 });

  const uses: TemplateMemberUse[] = [];
  for (const e of expressions) {
    for (const u of expressionUses(e.text)) {
      const at = e.at + u.at;
      const shadowed = locals.some((l) => l.name === u.name && l.from <= at && (l.scope !== e.scope || e.seesOwnLocals));
      if (!shadowed) uses.push({ name: u.name, at, call: u.call, via: e.via });
    }
  }
  return uses.sort((a, b) => a.at - b.at);
}

/**
 * What a method-kind member's own declaration says it is: an accessor (`get
 * canSave() {`), a function (`displayFn(p) {`, `onPick = (p) => …`), or a
 * field holding what a call returned (`days = Array.from({ length: 31 }, (_,
 * i) => i + 1)`, `total = computed(() => …)`) — a method only because a
 * callback is written in its initializer, and as likely plain data.
 */
type MemberShape = 'get' | 'set' | 'function' | 'value';

function memberShape(lines: readonly string[], member: Node): MemberShape {
  const head = lines
    .slice(member.startLine - 1, member.startLine + 4)
    .join('\n')
    .slice(member.startColumn);
  let from = 0;
  for (;;) {
    const at = head.indexOf(member.name, from);
    if (at < 0) return 'function';
    from = at + member.name.length;
    // The name itself — not a longer name, and not a decorator's `'value'` argument.
    if (/[\w$'"`]/.test(head[at - 1] ?? '') || /[\w$'"`]/.test(head[from] ?? '')) continue;
    const accessor = /(?<![\w$])(get|set)\s+$/.exec(head.slice(0, at));
    if (accessor) return accessor[1] as 'get' | 'set';
    // `name = …`, `name: Type = …` (a function type's `=>` is not the `=`).
    const field = /^[?!]?\s*(?::[^=;]*(?:=>[^=;]*)*)?=(?![=>])\s*/.exec(head.slice(from));
    if (!field) return 'function';
    const value = head.slice(from + field[0].length).replace(/^async\s+/, '');
    if (/^(?:function(?![\w$])|[A-Za-z_$][\w$]*\s*=>)/.test(value)) return 'function';
    const close = value.startsWith('(') ? matchBracket(value, 0) : -1;
    return close > 0 && /^\s*(?::[^=]*)?=>/.test(value.slice(close + 1)) ? 'function' : 'value';
  }
}

/**
 * The member one use links, and how. A call links what it calls: a method,
 * or a signal held in a field (`count = signal(0)` is a property). A name
 * read without a call links only a method-kind member — a getter runs when
 * it is read, so it is called; a function handed over uncalled
 * (`[displayWith]="displayFn"`) is a function reference; a field a call
 * filled (`@for (day of days)`) is a plain reference. Same-named methods
 * resolve as the event bindings' do: the last declared (an overload's body).
 */
function bindingTarget(
  candidates: readonly Node[] | undefined,
  call: boolean,
  shape: (n: Node) => MemberShape
): { node: Node; kind: 'calls' | 'references'; fnRef: boolean } | null {
  if (!candidates) return null;
  const methods = candidates.filter((n) => n.kind === 'method');
  if (call) {
    const target =
      [...methods].reverse().find((n) => shape(n) === 'function' || shape(n) === 'value') ??
      methods[0] ??
      candidates.find((n) => n.kind === 'property');
    return target ? { node: target, kind: 'calls', fnRef: false } : null;
  }
  const getter = methods.find((n) => shape(n) === 'get');
  if (getter) return { node: getter, kind: 'calls', fnRef: false };
  const read = [...methods].reverse().find((n) => shape(n) !== 'set');
  return read ? { node: read, kind: 'references', fnRef: shape(read) === 'function' } : null;
}

// =============================================================================
// The pass
// =============================================================================

export async function angularTemplateEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  if (!dependsOn(ctx, '@angular/core')) return [];
  const components = angularComponents(ctx);
  if (components.length === 0) return [];

  // Element selector → the components that answer to it, per app.
  const bySelector = new Map<string, AngularComponent[]>();
  for (const c of components) {
    for (const sel of c.selectors) {
      const list = bySelector.get(sel);
      if (list) list.push(c);
      else bySelector.set(sel, [c]);
    }
  }
  const childFor = (tag: string, parent: AngularComponent): AngularComponent | null => {
    const all = bySelector.get(tag);
    if (!all || all.length === 0) return null;
    if (all.length === 1) return all[0]!;
    const root = appRootFor(parent.file);
    const near = all.filter((c) => c.file.startsWith(root));
    return near.length === 1 ? near[0]! : null;
  };

  const table = angularRouteTable(ctx);
  const edges: Edge[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const component of components) {
    if ((++scanned & 31) === 0) await onYield();
    const template = component.template;
    if (!template) continue;
    const text = template.text;
    // Where an edge is written: the tag's own line for an inline template;
    // for a template file, the class — the file the edge's source is in.
    const siteLine = (at: number) => (template.inline ? template.firstLine + lineOfOffset(text, at) - 1 : component.node.startLine);
    const registeredAt = (at: number) => `${template.file}:${template.firstLine + lineOfOffset(text, at) - 1}`;

    let children = 0;
    TAG.lastIndex = 0;
    let t: RegExpExecArray | null;
    while ((t = TAG.exec(text)) !== null && children < MAX_CHILDREN_PER_COMPONENT) {
      const child = childFor(t[1]!, component);
      if (!child || child.node.id === component.node.id) continue;
      const key = `${component.node.id}>${child.node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      children++;
      edges.push({
        source: component.node.id,
        target: child.node.id,
        kind: 'calls',
        line: siteLine(t.index),
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'angular-template', via: t[1]!, registeredAt: registeredAt(t.index) },
      });
    }

    // Event bindings: `(click)="toggleFavorite()"` runs the component's own
    // method when the user acts. The binding is the trigger Steps draws —
    // known only from the template, so it rides on the edge.
    const own = ctx
      .getNodesInFile(component.file)
      .filter((n) => (n.kind === 'method' || n.kind === 'property') && n.qualifiedName.startsWith(`${component.node.qualifiedName}::`));
    const members = new Map(own.filter((n) => n.kind === 'method').map((n) => [n.name, n]));
    /** Members this template already links — only the first edge between two nodes survives the merge. */
    const linked = new Set<string>();
    let handlers = 0;
    EVENT_BINDING.lastIndex = 0;
    let ev: RegExpExecArray | null;
    while ((ev = EVENT_BINDING.exec(text)) !== null && handlers < MAX_CHILDREN_PER_COMPONENT) {
      const statement = ev[2] ?? ev[3] ?? '';
      const event = `(${ev[1]!})`;
      const element = elementAt(text, ev.index);
      OWN_CALL.lastIndex = 0;
      let c: RegExpExecArray | null;
      while ((c = OWN_CALL.exec(statement)) !== null) {
        const method = members.get(c[1]!);
        if (!method) continue;
        const key = `${component.node.id}>${method.id}>${event}`;
        if (seen.has(key)) continue;
        seen.add(key);
        linked.add(method.id);
        handlers++;
        edges.push({
          source: component.node.id,
          target: method.id,
          kind: 'calls',
          line: siteLine(ev.index),
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'angular-event',
            via: event,
            registeredAt: registeredAt(ev.index),
            trigger: { kind: 'prop', name: event, of: element },
          },
        });
      }
    }

    // Bindings: `[name]="icon()"`, `{{ label() }}`, `@if (loading())` read the
    // component every time it renders, so the hop carries no trigger. At most
    // one edge per member, so the class's own size bounds them.
    let declaration: string[] | null = null;
    const shapes = new Map<string, MemberShape>();
    const shape = (n: Node): MemberShape => {
      const known = shapes.get(n.id);
      if (known) return known;
      declaration ??= (ctx.readFile(component.file) ?? '').split('\n');
      const read = memberShape(declaration, n);
      shapes.set(n.id, read);
      return read;
    };
    const named = new Map<string, Node[]>();
    for (const n of own) {
      const list = named.get(n.name);
      if (list) list.push(n);
      else named.set(n.name, [n]);
    }
    for (const use of templateMemberUses(text)) {
      const found = bindingTarget(named.get(use.name), use.call, shape);
      if (!found || linked.has(found.node.id)) continue;
      linked.add(found.node.id);
      edges.push({
        source: component.node.id,
        target: found.node.id,
        kind: found.kind,
        line: siteLine(use.at),
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'angular-binding',
          via: use.via,
          registeredAt: registeredAt(use.at),
          ...(found.fnRef ? { fnRef: true } : {}),
        },
      });
    }

    const routes = angularRoutesFor(table, component.file);
    if (!routes || routes.exact.size === 0) continue;
    let links = 0;
    // A tab bar or menu built in the class — `this.tabs = [{ label, routerLink:
    // internalRoutes.home.subRoutes.summary.routerLink }]`, handed to a
    // `<gf-page-tabs [tabs]>` whose template binds `[routerLink]="tab.routerLink"`
    // in a loop. The destination is the field this class wrote.
    const source = ctx.readFile(component.file);
    if (source) {
      const lines = source.split('\n');
      const body = lines.slice(component.node.startLine - 1, component.node.endLine).join('\n');
      ROUTER_LINK_FIELD.lastIndex = 0;
      let f: RegExpExecArray | null;
      while ((f = ROUTER_LINK_FIELD.exec(body)) !== null && links < MAX_LINKS_PER_COMPONENT) {
        const value = fieldValue(body, f.index + f[0].length);
        const href = value ? angularDestination(value, component.file, component.node, ctx) : null;
        if (!href || !href.path.startsWith('/')) continue;
        const line = component.node.startLine + lineOfOffset(body, f.index) - 1;
        for (const dest of destinationsForHref(href, routes)) {
          const key = `${component.node.id}>${dest.node.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links++;
          edges.push({
            source: component.node.id,
            target: dest.node.id,
            kind: 'navigates',
            line,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'angular-router-link', href: dest.href.display, navMethod: 'routerLink', registeredAt: `${component.file}:${line}` },
          });
        }
      }
    }
    ROUTER_LINK.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = ROUTER_LINK.exec(text)) !== null && links < MAX_LINKS_PER_COMPONENT) {
      const value = r[2] ?? r[3] ?? '';
      const href = r[1] === '[routerLink]' ? angularDestination(value, component.file, component.node, ctx) : plainHref(value);
      if (!href || !href.path.startsWith('/')) continue;
      for (const dest of destinationsForHref(href, routes)) {
        const key = `${component.node.id}>${dest.node.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links++;
        edges.push({
          source: component.node.id,
          target: dest.node.id,
          kind: 'navigates',
          line: siteLine(r.index),
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'angular-router-link',
            href: dest.href.display,
            navMethod: 'routerLink',
            registeredAt: registeredAt(r.index),
            template: true,
          },
        });
      }
    }
  }
  return edges;
}
