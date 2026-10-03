import type { GraphSnapshot } from './graph-scene';
import { esc } from './export-svg';
import { endCapText } from './flow-model';

/** Standalone SVG from the current rendered geometry, including HTML card source text. */
export function snapshotSvg(snapshot: GraphSnapshot, scale = 1): string {
  const { nodes, edges } = snapshot;
  const minX = (snapshot.bounds?.x ?? Math.min(0, ...nodes.map(n => n.x))) - 32, minY = (snapshot.bounds?.y ?? Math.min(0, ...nodes.map(n => n.y))) - 48;
  const width = snapshot.bounds ? snapshot.bounds.width+64 : Math.max(320, ...nodes.map(n => n.x + n.width)) - minX + 32;
  const height = snapshot.bounds ? snapshot.bounds.height+96 : Math.max(160, ...nodes.map(n => n.y + n.height)) - minY + 32;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="${minX} ${minY} ${width} ${height}" role="img" aria-label="CodeGraph static relationships"><rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#f8fafc"/><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1 1 L9 5 L1 9 Z" fill="#466783"/></marker></defs>`];
  for(const group of snapshot.groups){const b=group.bounds;if(b)parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="6" fill="#f4f7fa" stroke="#91a4b4" stroke-dasharray="3 3"/><text x="${b.x+10}" y="${b.y+17}" font-family="sans-serif" font-size="12">${esc(group.label)} · ${group.members.length}</text>`);}
  for (const edge of edges) {
    if (!edge.path) continue;
    parts.push(`<path d="${esc(edge.path)}" fill="none" stroke="${edge.hot ? '#ad6500' : '#466783'}" stroke-width="${edge.hot ? 2.5 : edge.width}"${edge.dashed ? ` stroke-dasharray="${(edge.dashPattern??[5,3]).join(' ')}"` : ''}${edge.arrow !== false ? ' marker-end="url(#arrow)"' : ''}${edge.reverseCount ? ' marker-start="url(#arrow)"' : ''}/>`);
    if (edge.label && (edge.hot || edge.alwaysLabel)) {
      const a = nodes.find(n => n.id === edge.source), b = nodes.find(n => n.id === edge.target);
      if (a && b) edge.label.split('\n').forEach((line, i) => parts.push(`<text x="${edge.labelPoint?.x ?? (a.x + a.width + b.x) / 2}" y="${(edge.labelPoint?.y ?? (a.y + b.y) / 2 - 10) + i * 13}" text-anchor="middle" font-family="monospace" font-size="11" fill="#34485b">${esc(line)}</text>`));
    }
  }
  for (const node of nodes) {
    const color = node.selected ? '#ad6500' : '#91a4b4';
    parts.push(`<g transform="translate(${node.x},${node.y})">${node.kind === 'region' || node.kind === 'decision' ? '' : `<rect width="${node.width}" height="${node.height}" rx="4" fill="#fff" stroke="${color}" stroke-width="${node.selected ? 2.5 : 1}"${node.dashed ? ' stroke-dasharray="5 3"' : ''}/>`}<text x="10" y="18" font-family="monospace" font-size="13" fill="#172b3b">${esc((node.cyclic ? '↻ ' : '') + node.label)}</text>`);
    if (node.sub) parts.push(`<text x="10" y="33" font-family="sans-serif" font-size="11" fill="#526475">${esc(node.sub)}</text>`);
    const card = node.props?.data?.card;
    if (card) {
      const source = card.hop.source;
      const lines: string[] = source?.lines ?? [source?.drift ? 'Source changed since indexing' : source?.reason ?? 'Source unavailable'];
      lines.forEach((line, i) => {
        const row = (source?.from ?? 1) + i, isCall = row === card.hop.callRef?.line;
        parts.push(`<text x="10" y="${50 + i * 19}" font-family="monospace" font-size="12" fill="${isCall ? '#ad6500' : '#263a4c'}" xml:space="preserve">${esc(`${row}  ${line}`)}</text>`);
      });
    }
    const cap = node.props?.data?.cap;
    if (cap) {
      const t = endCapText(cap.boundary);
      const words = [t.intro, ...t.sites.flatMap(s => [s.headline, s.key, ...s.notes, ...s.candidates.map(c => c.node.name)]), t.quiet, t.uncertainHeading, ...t.uncertain.map(c => c.node.name), t.further, t.missed].filter(Boolean) as string[];
      let row = 0;
      for (const word of words) for (const line of word.match(/.{1,32}/gu) ?? []) parts.push(`<text x="10" y="${38 + row++ * 17}" font-family="sans-serif" font-size="11" fill="#34485b">${esc(line)}</text>`);
    }
    parts.push('</g>');
  }
  parts.push('</svg>'); return parts.join('');
}
