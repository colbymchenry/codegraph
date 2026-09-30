/**
 * Angular templates: what a component renders and where it links.
 *
 * An Angular component's markup is a template — a `templateUrl` file beside
 * it, or an inline `template:` string — that the index never parses, so two
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
