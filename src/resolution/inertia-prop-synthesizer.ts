/**
 * Inertia prop → consumer edges.
 *
 * The `inertia` framework resolver turns each server-side prop key into a node.
 * This pass closes the other half of the boundary: it finds the page component
 * the prop is rendered into and links the symbols there that actually READ it.
 *
 * WHICH SYMBOLS COUNT IS THE FEATURE.
 *
 * A naive scan reports a field as used the moment its name appears anywhere in
 * the page's file — which includes the `interface Props { … }` that declares it.
 * Every correctly typed field is then "used" by its own declaration, so nothing
 * is ever orphaned and the feature silently reports success while finding
 * nothing. Only sloppy, untyped fields would ever surface.
 *
 * The discriminator has to be per-SYMBOL, not per-file, because one module
 * routinely holds both halves: a shared client types module exports the payload
 * declarations AND runtime helpers over them, and is imported as a value
 * namespace by live code. Excluding the file loses every genuine consumer of
 * those helpers; including it re-commits the error above. A path- or
 * extension-based rule gets it wrong in one direction or the other, and both
 * directions are silent.
 *
 * So each occurrence is attributed to the INNERMOST symbol whose line range
 * contains it, and that symbol's kind decides (see `isPropConsumer`): a
 * `type`/`interface` declaration is not a consumer of the field it declares; a
 * function or value that reads it is.
 *
 * Test files are deliberately NOT excluded. A rendered-page test is sometimes
 * the only thing asserting a field's wording — content behind a portal never
 * reaches a server-rendered string, so the test calls the composer directly —
 * and excluding them would make a genuinely consumed export look dead.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { INERTIA_PROP_MARKER, clientCandidates } from './frameworks/inertia';
import { isPropConsumer } from './inertia-props';

/** Backstop only. */
const FANOUT_CAP = 20000;

/** Client component extensions Inertia resolves a page name to. */
const PAGE_EXTENSIONS = ['.tsx', '.jsx', '.vue', '.svelte', '.ts', '.js'];

/**
 * The file a page name renders into. Inertia resolves `"Reports/Index"` against
 * a pages directory by convention, so match on the path tail rather than
 * guessing a root — that works for `assets/js/Pages/`, `resources/js/Pages/`,
 * `app/javascript/Pages/` and anything else a project chose.
 */
export function findPageFile(page: string, files: readonly string[]): string | null {
  const wanted = page.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidates: string[] = [];
  for (const ext of PAGE_EXTENSIONS) {
    const tail = `/${wanted}${ext}`.toLowerCase();
    for (const file of files) {
      const lower = file.toLowerCase();
      if (!lower.endsWith(tail)) continue;
      // Require a `pages/` segment so an unrelated same-named module cannot be
      // mistaken for the page component.
      if (!/(^|\/)pages\//i.test(file)) continue;
      candidates.push(file);
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return null;
  // Shortest path wins when a project has more than one match — deeper paths
  // are usually variants (a `__tests__` copy, a storybook story).
  return candidates.sort((a, b) => a.length - b.length)[0]!;
}

/** The innermost node whose line range contains `line`. */
function innermostAt(nodes: readonly Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const node of nodes) {
    if (node.kind === 'file') continue;
    const end = node.endLine ?? node.startLine;
    if (node.startLine > line || end < line) continue;
    if (!best) { best = node; continue; }
    const bestSpan = (best.endLine ?? best.startLine) - best.startLine;
    if (end - node.startLine < bestSpan) best = node;
  }
  return best;
}

/** 1-based line numbers where `name` occurs as a whole identifier. */
function occurrenceLines(source: string, name: string): number[] {
  const lines: number[] = [];
  const re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g');
  let line = 1;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    for (let i = last; i < m.index; i++) if (source[i] === '\n') line++;
    last = m.index;
    lines.push(line);
  }
  return lines;
}

export async function inertiaPropEdges(
  ctx: ResolutionContext,
  onYield: MaybeYield
): Promise<Edge[]> {
  const props: Node[] = [];
  let scanned = 0;
  for (const node of ctx.iterateNodesByKind?.('property') ?? ctx.getNodesByKind('property')) {
    if ((++scanned & 63) === 0) await onYield();
    if (node.decorators?.includes(INERTIA_PROP_MARKER)) props.push(node);
  }
  if (props.length === 0) return [];

  const files = ctx.getAllFiles();
  const pageFileCache = new Map<string, string | null>();
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const prop of props) {
    await onYield();
    const page = prop.decorators?.find((d) => d.startsWith('page='))?.slice(5);
    if (!page) continue;

    let pageFile = pageFileCache.get(page);
    if (pageFile === undefined) {
      pageFile = findPageFile(page, files);
      pageFileCache.set(page, pageFile);
    }
    if (!pageFile) continue;

    const source = ctx.readFile(pageFile);
    if (!source) continue;
    const pageNodes = ctx.getNodesInFile(pageFile);
    const preserved = prop.decorators?.includes('preserve_case') ?? false;

    for (const candidate of clientCandidates(prop.name, preserved)) {
      for (const line of occurrenceLines(source, candidate)) {
        const owner = innermostAt(pageNodes, line);
        // An occurrence outside every symbol (a bare import line, module-level
        // JSX) has no consumer to attribute — counting it would reintroduce the
        // "named somewhere in the file" fallacy this pass exists to avoid.
        if (!owner || !isPropConsumer(owner.kind)) continue;
        const key = `${owner.id}>${prop.id}`;
        if (seen.has(key) || edges.length >= FANOUT_CAP) continue;
        seen.add(key);
        edges.push({
          // The consumer depends on the prop, so impact on a prop lists what
          // reads it — and a prop with no incoming edge is a dead prop.
          source: owner.id,
          target: prop.id,
          kind: 'references',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'inertia-prop',
            page,
            serverKey: prop.name,
            // Which spelling actually matched, so a camelizing project and a
            // verbatim one are distinguishable without knowing the setting.
            clientKey: candidate,
            registeredAt: `${pageFile}:${line}`,
          },
        });
      }
    }
  }

  return edges;
}
