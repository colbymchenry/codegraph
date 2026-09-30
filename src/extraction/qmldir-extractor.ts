import { Node, ExtractionResult, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

export class QmldirExtractor {
  private readonly filePath: string;
  private readonly source: string;

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    const nodes: Node[] = [];
    const lines = this.source.split('\n');
    let moduleName = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line || line.startsWith('#')) continue;

      const parts = line.split(/\s+/);
      const directive = parts[0];

      if (directive === 'module' && parts[1]) {
        moduleName = parts[1];
        const nodeId = generateNodeId(this.filePath, 'namespace', moduleName, i + 1);
        nodes.push({
          id: nodeId,
          kind: 'namespace',
          name: moduleName,
          qualifiedName: moduleName,
          filePath: this.filePath,
          language: 'qml' as Language,
          startLine: i + 1,
          endLine: i + 1,
          startColumn: 0,
          endColumn: line.length,
          updatedAt: Date.now(),
        });
      } else if (directive === 'singleton' || directive === 'internal' || /^[A-Z]/.test(directive!)) {
        const isModifier = directive === 'singleton' || directive === 'internal';
        let typeName = '';
        let fileIndex = -1;

        if (isModifier) {
          typeName = parts[1] ?? '';
          fileIndex = parts.findIndex(p => p.endsWith('.qml') || p.endsWith('.js'));
        } else {
          typeName = directive!;
          fileIndex = parts.findIndex(p => p.endsWith('.qml') || p.endsWith('.js'));
        }

        if (typeName && fileIndex > 0) {
          const qmlFile = parts[fileIndex]!;
          const nodeId = generateNodeId(this.filePath, 'component', typeName, i + 1);
          nodes.push({
            id: nodeId,
            kind: 'component',
            name: typeName,
            qualifiedName: moduleName ? `${moduleName}::${typeName}` : typeName,
            filePath: this.filePath,
            language: 'qml' as Language,
            startLine: i + 1,
            endLine: i + 1,
            startColumn: 0,
            endColumn: line.length,
            signature: `qmldir component ${typeName} -> ${qmlFile}`,
            updatedAt: Date.now(),
          });
        }
      }
    }

    return {
      nodes,
      edges: [],
      unresolvedReferences: [],
      errors: [],
      durationMs: Date.now() - startTime,
    };
  }
}
