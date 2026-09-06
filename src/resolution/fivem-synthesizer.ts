/**
 * FiveM — the dispatch half of string-keyed dispatch. See `frameworks/fivem.ts` for
 * the registrar half and the shape of the problem.
 *
 * For every literal-keyed dispatch site inside a resource —
 *
 *   TriggerEvent / TriggerServerEvent / TriggerClientEvent / TriggerLatent*Event('e', …)
 *   emit / emitNet('e', …)                                        (JS side)
 *   exports['res']:Fn(…)  exports.res:Fn(…)  exports.res.Fn(…)  exports['res'].Fn(…)
 *   lib.callback('c', …) / lib.callback.await('c', …) / QBCore.Functions.TriggerCallback('c', …)
 *   ExecuteCommand('cmd …')
 *   fetch(`https://res/name`)                                     (NUI → RegisterNUICallback)
 *
 * — link the enclosing function (or the file, for top-level code) to every handler node the
 * resolver created for that key. Keys are global by construction, so this is the one place a
 * cross-resource edge is drawn. A key with no registered handler yields nothing; a handler
 * registered in several resources (`playerSpawned`-style broadcast events) yields one edge
 * each, capped, because that fan-out is the truth of the runtime, not noise.
 *
 * Edges: `kind:'calls'`, `provenance:'heuristic'`, `synthesizedBy:'fivem-dispatch'`, `via` =
 * the key, `registeredAt` = the handler's file:line. Precision floor: literal keys only; a
 * computed key (`TriggerEvent(name, …)`) is left for boundary surfacing.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { enclosingFn } from './synth-utils';
import { FIVEM_NODE_PREFIX, fivemLanguageFor, fivemResourceOf, fivemResourceRootsFrom, isFivemNuiFile, stripForFivem } from './frameworks/fivem';

const Q = `(['"\`])`;
const LIT = `([^'"\`\\n]+)`;
const ID = `([A-Za-z_][A-Za-z0-9_]*)`;

/** Not preceded by `.`/`:`/word — a member call is somebody's method, not a FiveM global. */
const G = `(?<![\\w.:])`;

/** Sentinel: the dispatching file's own resource (NUI pages talk to the resource that serves them). */
const SELF = '\0self';

interface DispatchSpec {
  re: RegExp;
  /** handler-node name to look up, plus the resource the site names (exports / NUI) when it names one */
  key: (m: RegExpExecArray) => { key: string; res?: string };
  /** the one dispatch shape browser (NUI) code can perform */
  nui?: true;
}
const DISPATCHERS: DispatchSpec[] = [
  { re: new RegExp(`${G}(?:TriggerEvent|TriggerServerEvent|TriggerClientEvent|TriggerLatentServerEvent|TriggerLatentClientEvent|emit|emitNet)\\s*\\(\\s*${Q}${LIT}\\1`, 'g'), key: (m) => ({ key: `event:${m[2]}` }) },
  { re: new RegExp(`${G}exports\\s*\\[\\s*${Q}${LIT}\\1\\s*\\]\\s*[:.]\\s*${ID}\\s*\\(`, 'g'), key: (m) => ({ key: `export:${m[3]}`, res: m[2]! }) },
  { re: new RegExp(`${G}exports\\.${ID}\\s*[:.]\\s*${ID}\\s*\\(`, 'g'), key: (m) => ({ key: `export:${m[2]}`, res: m[1]! }) },
  { re: new RegExp(`${G}(?:lib\\.callback(?:\\.await)?|QBCore\\.Functions\\.TriggerCallback)\\s*\\(\\s*${Q}${LIT}\\1`, 'g'), key: (m) => ({ key: `callback:${m[2]}` }) },
  { re: new RegExp(`${G}ExecuteCommand\\s*\\(\\s*${Q}([^'"\`\\s]+)`, 'g'), key: (m) => ({ key: `command:${m[2]}` }) },
  // NUI → RegisterNUICallback. A page almost never spells its resource: it is
  // `https://${GetParentResourceName()}/name` (any `${…}` host) or ox_lib's `fetchNui('name')`, both
  // meaning "my own resource" — resolved from the file's location. A literal host is honoured as written.
  { re: new RegExp(`${G}fetch\\s*\\(\\s*${Q}https?://([^/'"\`$]+)/([^'"\`?\\s]+)`, 'g'), key: (m) => ({ key: `nui:${m[3]}`, res: m[2]! }), nui: true },
  { re: new RegExp(`${G}fetch\\s*\\(\\s*\`https?://\\$\\{[^}]*\\}/([^\`?\\s]+)`, 'g'), key: (m) => ({ key: `nui:${m[1]}`, res: SELF }), nui: true },
  { re: new RegExp(`${G}fetchNui\\s*(?:<[^>]*>)?\\s*\\(\\s*${Q}${LIT}\\1`, 'g'), key: (m) => ({ key: `nui:${m[2]}`, res: SELF }), nui: true },
];



// An event legitimately has as many receivers as resources listen to it (`QBCore:Client:OnPlayerLoaded`
// has ~30 in a stock pack) — that fan-out is the runtime's truth, not noise, so events are uncapped.
// An export / callback / command / NUI callback resolves to one registration in one resource; more than
// a few means duplicate registrations, still real, but bounded.
const FANOUT_CAP_KEYED = 8;

export async function fivemDispatchEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const files = ctx.getAllFiles();
  const roots = fivemResourceRootsFrom(files);
  if (roots.length === 0) return [];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const file of files) {
    const language = fivemLanguageFor(file);
    if (!language || !fivemResourceOf(file, roots)) continue;
    if ((++scanned & 15) === 0) await onYield();
    const content = ctx.readFile(file);
    if (!content) continue;
    if (!/Trigger|emit|exports|callback|ExecuteCommand|fetch/.test(content)) continue;
    const src = stripForFivem(content, language);
    const nodesInFile = ctx.getNodesInFile(file);
    const fileNode = nodesInFile.find((n) => n.kind === 'file' || n.kind === 'module') ?? null;
    const nui = isFivemNuiFile(file);
    const ownResource = fivemResourceOf(file, roots)?.name;
    for (const spec of DISPATCHERS) {
      if (nui && !spec.nui) continue;
      spec.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = spec.re.exec(src))) {
        const keyed = spec.key(m);
        const key = keyed.key;
        const res = keyed.res === SELF ? ownResource : keyed.res;
        const line = src.slice(0, m.index).split('\n').length;
        const disp: Node | null = enclosingFn(nodesInFile, line) ?? fileNode;
        if (!disp) continue;
        // `exports['res']:Fn` / NUI `https://res/name` name a resource: only that resource's handler counts.
        const targets = ctx
          .getNodesByName(key)
          .filter((n) => n.id.startsWith(FIVEM_NODE_PREFIX) && n.id !== disp.id && (res === undefined || fivemResourceOf(n.filePath, roots)?.name === res));
        const via = res === undefined ? key : `${key.slice(0, key.indexOf(':'))}:${res}/${key.slice(key.indexOf(':') + 1)}`;
        for (const t of key.startsWith('event:') ? targets : targets.slice(0, FANOUT_CAP_KEYED)) {
          const k = `${disp.id}>${t.id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          edges.push({
            source: disp.id,
            target: t.id,
            kind: 'calls',
            line,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'fivem-dispatch', via, registeredAt: `${t.filePath}:${t.startLine}` },
          });
        }
      }
    }
  }
  return edges;
}
