const { extractFromSource } = require('./dist/extraction');
const { initGrammars, loadAllGrammars } = require('./dist/extraction/grammars');

(async () => {
  await initGrammars();
  await loadAllGrammars();

  const code = `
class Parent:
    pass

class Child(Parent):
    pass

class Multiple(Parent, Mixin):
    pass
`;

  const result = extractFromSource('test.py', code);

  console.log('=== NODES ===');
  result.nodes.forEach(n => {
    console.log(`${n.kind}: ${n.name} (line ${n.startLine})`);
  });

  console.log('\n=== UNRESOLVED REFERENCES ===');
  result.unresolvedReferences.forEach(r => {
    console.log(`${r.referenceKind}: ${r.referenceName} (from ${r.fromNodeId})`);
  });

  console.log('\n=== EDGES ===');
  result.edges.forEach(e => {
    console.log(`${e.kind}: ${e.source} -> ${e.target}`);
  });
})();
