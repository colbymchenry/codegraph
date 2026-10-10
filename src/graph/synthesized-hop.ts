/**
 * How a synthesized hop reads — what bridged the call, and where it was wired.
 *
 * Static parsing cannot see a handler registered in one place and run in
 * another, so the resolver synthesizes the `calls` edge across it
 * (`provenance: 'heuristic'`, `metadata.synthesizedBy`, and usually a
 * `metadata.registeredAt` wiring site). Whatever prints that hop has to say what
 * bridged it, or the hop reads as a direct call — or as the wrong mechanism.
 *
 * Two surfaces print one. `codegraph_explore` (its Flow section and its
 * dynamic-dispatch links) and the `codegraph_node` trail tag the hop
 * `dynamic: callback via \`subscribe\` @src/store.ts:4`; ContextBuilder's
 * "## Call paths" (`buildContext`, `codegraph context`) writes it inside the
 * arrow, `→[callback via \`subscribe\` @src/store.ts:4]`. Each used to keep its
 * own list, and the shorter one called every synthesizer it did not know —
 * interface dispatch, a C++ override, a redux thunk — an "event". So the
 * wording lives here once, and each surface renders it.
 */

import type { Edge } from '../types';

export interface SynthesizedHop {
  /** What bridged the hop: "callback via `subscribe`", "interface → impl", "redux thunk". */
  summary: string;
  /**
   * What the call-paths rendering adds after the summary — the queue a job runs
   * on, a socket message's direction, what an HTTP hop is; '' when nothing.
   */
  detail: string;
  /** Where the hop was wired up (`file:line`), when the synthesizer recorded it. */
  registeredAt?: string;
}

/**
 * Describe a synthesized (dynamic-dispatch) edge; null for an ordinary static
 * one. A synthesizer not named below still reads as dynamic dispatch, by its own
 * name and with its wiring site — never as a bare call or a borrowed label.
 */
export function describeSynthesizedHop(edge: Edge | null | undefined): SynthesizedHop | null {
  const m = edge?.provenance === 'heuristic' ? (edge.metadata as Record<string, unknown> | undefined) : undefined;
  const by = m?.synthesizedBy;
  if (!m || typeof by !== 'string') return null;
  const registeredAt = typeof m.registeredAt === 'string' ? m.registeredAt : undefined;
  const hop = (summary: string, detail = ''): SynthesizedHop => ({ summary, detail, registeredAt });
  const quoted = (value: unknown, otherwise: string): string => (value ? `\`${String(value)}\`` : otherwise);
  switch (by) {
    case 'callback':
      return hop(`callback via ${quoted(m.via, 'a registrar')}`);
    case 'http-client': {
      const request = `${String(m.method ?? 'GET')} ${String(m.href ?? '')}`.trim();
      return hop(`HTTP ${request}`, " — the client's call onto its own route");
    }
    case 'queue-job':
      return hop(`queue job ${quoted(m.event, 'a job')}`, m.queue ? ` on \`${String(m.queue)}\`` : '');
    case 'event-bus': {
      const what = m.channel === 'socket' ? 'socket message' : 'bus event';
      const direction = m.tier === 'client→server' ? ' → server' : m.tier === 'server→client' ? ' → client' : '';
      return hop(`${what} ${quoted(m.event, 'an event')}`, direction);
    }
    case 'event-emitter':
      return hop(`event ${quoted(m.event, 'an event')}`);
    case 'react-render':
      return hop('React re-render via setState');
    case 'jsx-render':
      return hop(`renders ${m.via ? `<${String(m.via)}>` : 'a child component'}`);
    case 'vue-handler':
      return hop(`Vue ${m.event ? `@${String(m.event)}` : 'a template event'} handler`);
    case 'interface-impl':
      // Go: the implementing struct gets the method from a type it embeds.
      if (typeof m.promotedInto === 'string') return hop(`interface → method promoted into ${m.promotedInto}`);
      return hop('interface → impl');
    case 'closure-collection':
      return hop(`runs ${quoted(m.field, 'a collection')} handlers`);
    case 'fn-pointer-dispatch':
      return hop(`fn-pointer ${m.via ? String(m.via) : ''}`);
    case 'goframe-route':
      return hop(`GoFrame route ${m.route ? String(m.route) : ''}`);
    default:
      // redux-thunk, cpp-override, gin-middleware-chain, flutter-build, …
      return hop(by.replace(/-/g, ' '));
  }
}
