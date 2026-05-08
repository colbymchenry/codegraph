const { getParser, initGrammars, loadAllGrammars } = require('./dist/extraction/grammars');

(async () => {
  await initGrammars();
  await loadAllGrammars();

  const parser = getParser('python');

  const code = `class Child(Parent):
    pass`;

  const tree = parser.parse(code);

  function walk(node, depth = 0) {
    const indent = '  '.repeat(depth);
    const preview = node.text.substring(0, 30).replace(/\n/g, '\\n');
    console.log(`${indent}${node.type} [${node.startPosition.row}:${node.startPosition.column}] "${preview}"`);
    
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child, depth + 1);
    }
  }

  walk(tree.rootNode);
})();
