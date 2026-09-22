/** The starter is emitted by the CLI, so it ships inside the compiled bundle. */
export function extensionTemplate(id: string): string {
  return `'use strict';
// Editor types come from the public SDK, with no runtime import or dependency.
/** @type {import('@colbymchenry/codegraph').CodeGraphPlugin} */
module.exports = () => ({
  frameworks: [{
    name: 'python-event-map',
    languages: ['yaml'],
    detect: graph => graph.getAllFiles().some(file => file.endsWith('.events.yaml')),
    claimsReference: name => name.startsWith('${id}:'),
    extract(file, source) {
      const nodes = [], references = [];
      if (!file.endsWith('.events.yaml')) return { nodes, references };
      // Deliberately narrow syntax: one literal event: handler per line.
      // Nested YAML, aliases, quoted/computed values and comments do not match.
      source.split(/\\r?\\n/).forEach((text, index) => {
        const match = /^([a-z][a-z0-9_.-]*):[ \\t]+([A-Za-z_]\\w*)[ \\t]*$/.exec(text);
        if (!match) return;
        const [, event, handler] = match, line = index + 1;
        const nodeId = 'plugin:${id}:' + file + ':' + line;
        nodes.push({ id: nodeId, kind: 'route', name: 'event:' + event,
          qualifiedName: file + '::event:' + event + ':' + line, filePath: file,
          language: 'yaml', startLine: line, endLine: line,
          startColumn: 0, endColumn: text.length, updatedAt: 0 });
        references.push({ fromNodeId: nodeId, referenceName: '${id}:' + handler,
          referenceKind: 'calls', filePath: file, language: 'yaml', line, column: 0 });
      });
      return { nodes, references };
    },
    resolve(ref, graph) {
      if (!ref.referenceName.startsWith('${id}:')) return null;
      const name = ref.referenceName.slice('${id}:'.length);
      const targets = graph.getNodesByName(name).filter(node =>
        node.language === 'python' && node.kind === 'function');
      // Ambiguity and missing handlers stay unresolved; never guess an endpoint.
      if (targets.length !== 1) return null;
      return { original: ref, targetNodeId: targets[0].id, confidence: 1,
        resolvedBy: 'framework', edgeKind: 'calls', metadata: {
          label: 'Python event dispatch', registeredAt: ref.filePath + ':' + ref.line
        } };
    }
  }]
});
`;
}

export function extensionFixtures(): object {
  return {
    format: 'codegraph-extension-tests-1',
    cases: [
      {
        name: 'literal event reaches its Python handler; unknown and computed targets do not',
        files: {
          'checkout.events.yaml': 'order.created: send_receipt\norder.missing: missing_handler\n# ignored.event: send_receipt\ncomputed.event: ${handler}\n',
          'handlers.py': 'def send_receipt():\n    return "sent"\n',
        },
        expect: {
          nodes: [{ name: 'event:order.created', kind: 'route' }, { name: 'event:order.missing', kind: 'route' }],
          edges: [{ source: 'event:order.created', target: 'send_receipt', label: 'Python event dispatch' }],
          absentNodes: [{ name: 'event:ignored.event' }, { name: 'event:computed.event' }],
          absentEdges: [{ source: 'event:order.missing' }],
        },
      },
      {
        name: 'ambiguous Python handlers stay unresolved',
        files: {
          'checkout.events.yaml': 'order.created: send_receipt\n',
          'one.py': 'def send_receipt():\n    pass\n',
          'two.py': 'def send_receipt():\n    pass\n',
        },
        expect: { nodes: [{ name: 'event:order.created' }], absentEdges: [{ source: 'event:order.created' }] },
      },
    ],
  };
}
