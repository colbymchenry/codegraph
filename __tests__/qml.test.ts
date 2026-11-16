/**
 * QML Extractor Tests
 *
 * Tests for the QmlExtractor (QML declarative UI files) and
 * the Qt framework resolver (C++ signal/slot extraction).
 */

import { beforeAll, describe, it, expect } from 'vitest';
import { QmlExtractor } from '../src/extraction/qml-extractor';
import { TreeSitterExtractor } from '../src/extraction/tree-sitter';
import { preloadLanguagesForFiles } from '../src/extraction';
import { qtResolver } from '../src/resolution/frameworks/qt';
import {
    detectLanguage,
    includeEmbeddedGrammarDependencies,
    initGrammars,
    isSourceFile,
    loadGrammarsForLanguages,
} from '../src/extraction/grammars';
import { blankQtMacros } from '../src/extraction/languages/c-cpp';

beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['qml', 'javascript']);
});

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

describe('QML language detection', () => {
  it('detects .qml as qml', () => {
    expect(detectLanguage('ui/Main.qml')).toBe('qml');
    expect(detectLanguage('components/Button.qml')).toBe('qml');
  });

  it('treats .qml as a source file', () => {
    expect(isSourceFile('ui/Main.qml')).toBe(true);
  });

    it('loads JavaScript grammar for embedded QML bodies', () => {
        expect(includeEmbeddedGrammarDependencies(['qml'])).toEqual(['qml', 'javascript']);
    });

    it('preloads JavaScript for QML files', () => {
        expect(preloadLanguagesForFiles(['ui/Main.qml'])).toEqual(['qml', 'javascript']);
    });
});

// ---------------------------------------------------------------------------
// QML Extractor
// ---------------------------------------------------------------------------

describe('QmlExtractor — imports', () => {
  it('extracts a plain module import', () => {
    const src = `
import QtQuick
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imp = result.nodes.find((n) => n.kind === 'import');
    expect(imp).toBeDefined();
    expect(imp!.name).toBe('QtQuick');
    expect(imp!.language).toBe('qml');
  });

  it('extracts a versioned import', () => {
    const src = `
import QtQuick 2.15
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imp = result.nodes.find((n) => n.kind === 'import');
    expect(imp).toBeDefined();
    expect(imp!.name).toBe('QtQuick');
  });

  it('extracts a qualified module import', () => {
    const src = `
import Qt.labs.platform
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imp = result.nodes.find((n) => n.kind === 'import');
    expect(imp!.name).toBe('Qt.labs.platform');
  });

  it('extracts a directory import with quotes', () => {
    const src = `
import "components"
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imp = result.nodes.find((n) => n.kind === 'import');
    expect(imp!.name).toBe('components');
  });

  it('extracts multiple imports', () => {
    const src = `
import QtQuick 2.15
import QtQuick.Controls 2.15
import "components"
Item {}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const imports = result.nodes.filter((n) => n.kind === 'import');
    expect(imports).toHaveLength(3);
    expect(imports.map((i) => i.name)).toContain('QtQuick');
    expect(imports.map((i) => i.name)).toContain('QtQuick.Controls');
    expect(imports.map((i) => i.name)).toContain('components');
  });
});

describe('QmlExtractor — root component', () => {
    it('uses the file component as the root id call and signal owner', () => {
        const src = `import QtQuick
Item {
  id: root
  signal changed()
  function refresh() {}
  function run() { root.refresh() }
  Connections {
    target: root
    function onChanged() { refresh() }
  }
}`;
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
            referenceName: 'root.refresh', candidates: ['qt.qml-id|root|Main|refresh'],
        }));
        expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
            referenceName: 'changed', referenceKind: 'references', candidates: ['Main::changed'],
        }));
        const call = result.unresolvedReferences.find((reference) => reference.referenceName === 'root.refresh');
        const refresh = result.nodes.find((node) => node.kind === 'function' && node.name === 'refresh');
        const context = {
            getAllFiles: () => ['ui/Main.qml'],
            readFile: (filePath: string) => filePath === 'ui/Main.qml' ? src : null,
            getNodesInFile: (filePath: string) => result.nodes.filter((node) => node.filePath === filePath),
            getNodesByName: (name: string) => result.nodes.filter((node) => node.name === name),
            getNodesByQualifiedName: (name: string) => result.nodes.filter((node) => node.qualifiedName === name),
            getNodesByKind: (kind: string) => result.nodes.filter((node) => node.kind === kind),
            getNodesByLowerName: (name: string) => result.nodes.filter((node) => node.name.toLowerCase() === name),
            fileExists: () => false,
            getProjectRoot: () => '/tmp',
            getImportMappings: () => [],
        };
        expect(refresh).toBeDefined();
        expect(qtResolver.resolve(call!, context)?.targetNodeId).toBe(refresh!.id);
    });

  it('creates a component node named after the .qml file', () => {
    const src = `
import QtQuick
Rectangle {
  width: 200
  height: 100
}
`.trim();
    const result = new QmlExtractor('ui/MyButton.qml', src).extract();
    const comp = result.nodes.find((n) => n.kind === 'component');
    expect(comp).toBeDefined();
    expect(comp!.name).toBe('MyButton');
    expect(comp!.language).toBe('qml');
    expect(comp!.isExported).toBe(true);
  });

  it('marks the root component as exported', () => {
    const src = `import QtQuick\nItem {}`;
    const result = new QmlExtractor('views/LoginView.qml', src).extract();
    const comp = result.nodes.find((n) => n.kind === 'component');
    expect(comp!.isExported).toBe(true);
    expect(comp!.name).toBe('LoginView');
  });
});

describe('QmlExtractor — property declarations', () => {
    it('collects multiline object and block bindings without losing the following function', () => {
        const src = `import QtQuick
Item {
  property var data: ({
    nested: { value: service.read() }
  })
  property int count: {
    if (data.nested) { service.count() }
    return 1
  }
  visible: {
    if (count) { service.check() }
    return true
  }
  function refresh() { service.refresh() }
}`;
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const root = result.nodes.find((node) => node.kind === 'component' && node.isExported);
        const data = result.nodes.find((node) => node.kind === 'property' && node.name === 'data');
        const count = result.nodes.find((node) => node.kind === 'property' && node.name === 'count');
        const refresh = result.nodes.find((node) => node.kind === 'function' && node.name === 'refresh');

        expect(result.errors).toEqual([]);
        expect(data).toMatchObject({ startLine: 3, endLine: 5 });
        expect(count).toMatchObject({ startLine: 6, endLine: 9 });
        expect(refresh).toBeDefined();
        for (const child of [data, count, refresh]) {
            expect(result.edges).toContainEqual({ source: root!.id, target: child!.id, kind: 'contains' });
        }
        for (const [referenceName, owner] of [
            ['service.read', data], ['service.count', count], ['service.check', root], ['service.refresh', refresh],
        ] as const) {
            expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
                fromNodeId: owner!.id, referenceName, referenceKind: 'calls',
            }));
        }
    });

  it('extracts a simple property', () => {
    const src = `
import QtQuick
Item {
    property int count: 0
}
`.trim();
    const result = new QmlExtractor('ui/Counter.qml', src).extract();
    const prop = result.nodes.find((n) => n.kind === 'property' && n.name === 'count');
    expect(prop).toBeDefined();
    expect(prop!.signature).toContain('property int count');
  });

  it('extracts a readonly property', () => {
    const src = `
import QtQuick
Item {
    readonly property string title: "Hello"
}
`.trim();
    const result = new QmlExtractor('ui/Widget.qml', src).extract();
    const prop = result.nodes.find((n) => n.kind === 'property' && n.name === 'title');
    expect(prop).toBeDefined();
  });

  it('extracts a required property', () => {
    const src = `
import QtQuick
Item {
    required property var model
}
`.trim();
    const result = new QmlExtractor('ui/Widget.qml', src).extract();
    const prop = result.nodes.find((n) => n.kind === 'property' && n.name === 'model');
    expect(prop).toBeDefined();
  });
});

describe('QmlExtractor — signal declarations', () => {
  it('extracts a no-arg signal', () => {
    const src = `
import QtQuick
Item {
    signal clicked()
}
`.trim();
    const result = new QmlExtractor('ui/Button.qml', src).extract();
    const sig = result.nodes.find((n) => n.kind === 'method' && n.name === 'clicked');
    expect(sig).toBeDefined();
    expect(sig!.signature).toContain('signal clicked');
  });

  it('extracts a parametrized signal', () => {
    const src = `
import QtQuick
Item {
    signal valueChanged(real newValue)
}
`.trim();
    const result = new QmlExtractor('ui/Slider.qml', src).extract();
    const sig = result.nodes.find((n) => n.kind === 'method' && n.name === 'valueChanged');
    expect(sig).toBeDefined();
  });

  it('extracts multiple signals', () => {
    const src = `
import QtQuick
Item {
    signal pressed()
    signal released()
    signal clicked()
}
`.trim();
    const result = new QmlExtractor('ui/Button.qml', src).extract();
    const sigs = result.nodes.filter((n) => n.kind === 'method');
    expect(sigs.length).toBeGreaterThanOrEqual(3);
  });
});

describe('QmlExtractor — signal handler bindings', () => {
    it.each(['function onChanged(value)', 'onChanged:'])(
        'delays %s until its literal local target and id are known',
        (declaration) => {
            const src = `import QtQuick
Item {
  Connections {
    ${declaration} {
      publishValue()
    }
    target: backend
  }
  NativePanel {
    id: backend
  }
}`;
            const result = new QmlExtractor('ui/Main.qml', src).extract();
            const handler = result.nodes.find((node) => node.name === 'onChanged');
            const associations = result.unresolvedReferences.filter(
                (reference) => reference.fromNodeId === handler?.id && reference.referenceKind === 'references',
            );

            expect(handler).toMatchObject({
                kind: 'method', startLine: 4, endLine: 6, endColumn: src.split('\n')[5]!.indexOf('}') + 1,
            });
            expect(associations).toEqual([expect.objectContaining({
                referenceName: 'changed', candidates: ['NativePanel::changed'],
            })]);
        },
    );

    it.each(['function onChanged(value)', 'onChanged:'])(
        'marks %s with a delayed literal context signal candidate',
        (declaration) => {
            const src = `import QtQuick
Item {
  Connections {
    ${declaration} {
      publishValue()
    }
    target: reportService
  }
}`;
            const result = new QmlExtractor('ui/Main.qml', src).extract();
            const handler = result.nodes.find((node) => node.name === 'onChanged');
            const associations = result.unresolvedReferences.filter(
                (reference) => reference.fromNodeId === handler?.id && reference.referenceKind === 'references',
            );

            expect(associations).toEqual([expect.objectContaining({
                referenceName: 'changed', candidates: ['qt.context-signal|reportService|changed'],
            })]);
        },
    );

    it.each([
        ['condition ? backend : other', '', ''],
        ['backend', '    property var backend\n', ''],
        ['backend', '', 'import "backend.js" as backend\n'],
        ['backend', '    NativePanel {\n        id: backend\n    }\n    NativePanel {\n        id: backend\n    }\n', ''],
        ['backend', '    NativePanel {\n        id: backend\n    }\n    OtherPanel {\n        id: backend\n    }\n', ''],
    ])('leaves both Connections syntaxes unresolved for target %s with shadows or ambiguity', (target, setup, imports) => {
        const src = `import QtQuick
${imports}Item {
${setup}    Connections {
    function onChanged(value) {
      publishValue()
    }
    target: ${target}
  }
  Connections {
    onChanged: {
      publishValue()
    }
    target: ${target}
  }
}`;
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const handlers = result.nodes.filter((node) => node.name === 'onChanged');

        expect(handlers).toHaveLength(2);
        for (const handler of handlers) {
            expect(result.unresolvedReferences.filter(
                (reference) => reference.fromNodeId === handler.id && reference.referenceKind === 'references',
            )).toEqual([]);
        }
    });

  it('extracts an onClicked handler', () => {
    const src = `
import QtQuick
Item {
    MouseArea {
        onClicked: console.log("clicked")
    }
}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const handler = result.nodes.find((n) => n.kind === 'method' && n.name === 'onClicked');
    expect(handler).toBeDefined();
  });

    it('emits an unresolved reference association from handler to signal name', () => {
    const src = `
import QtQuick
Item {
    onFooChanged: doSomething()
}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const ref = result.unresolvedReferences.find((r) => r.referenceName === 'fooChanged');
    expect(ref).toBeDefined();
      expect(ref!.referenceKind).toBe('references');
      expect(ref!.candidates).toEqual(['Main::fooChanged']);
  });

    it('records the nested component type as the signal owner', () => {
        const src = `
import QtQuick
Item {
    CustomPanel {
        onSaved: publishValue()
    }
}
`.trim();
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const ref = result.unresolvedReferences.find((r) => r.referenceName === 'saved');
        expect(ref?.candidates).toEqual(['CustomPanel::saved']);
  });
});

describe('QmlExtractor — function declarations', () => {
    it('includes the closing brace in multiline function and handler ranges', () => {
        const src = `import QtQuick
Item {
  function refresh() {
    if (ready) { service.refresh() }
  }
  onVisibleChanged: {
    service.update()
  }
  Component.onCompleted: {
    service.start()
  }
  Connections {
    target: service
    function onChanged(value) {
      service.consume(value)
    }
  }
}`;
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        for (const [name, startLine, endLine] of [
            ['refresh', 3, 5], ['onVisibleChanged', 6, 8], ['Component.onCompleted', 9, 11], ['onChanged', 14, 16],
        ] as const) {
            const node = result.nodes.find((candidate) => candidate.name === name);
            const closingLine = src.split('\n')[endLine - 1]!;
            expect(node).toMatchObject({ startLine, endLine, endColumn: closingLine.indexOf('}') + 1 });
        }
        expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
            referenceName: 'service.consume', line: 15,
        }));
    });

  it('extracts a function node', () => {
    const src = `
import QtQuick
Item {
    function greet(name) {
        return "Hello " + name
    }
}
`.trim();
    const result = new QmlExtractor('ui/Greeter.qml', src).extract();
    const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain('function greet');
  });

    it('ignores quoted braces and comments while collecting a same-line body', () => {
        const src = `
import QtQuick
Item {
    /* A commented QML close must not pop Item.
       }
    */
    function update() { const endpoint = "http://example.test/}"; backend.refresh() } // real comment
    Rectangle {}
}
`.trim();
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const refreshCalls = result.unresolvedReferences.filter(
            (reference) => reference.referenceKind === 'calls' && reference.referenceName === 'backend.refresh',
        );
        const root = result.nodes.find((node) => node.kind === 'component' && node.name === 'Main');
        const rectangle = result.nodes.find((node) => node.kind === 'component' && node.name === 'Rectangle');
        const importNode = result.nodes.find((node) => node.kind === 'import' && node.name === 'QtQuick');

        expect(refreshCalls).toHaveLength(1);
        expect(rectangle).toBeDefined();
        expect(root?.endLine).toBe(src.split('\n').length);
        expect(importNode?.endLine).toBe(1);
    });

    it('keeps handler collection open through quoted braces and block comments', () => {
        const src = `
import QtQuick
Item {
    MouseArea {
        onClicked: {
            const endpoint = "http://example.test/}"
            // } is a real line comment
            /* { and } are a real block comment
             */
            service.start()
        }
    }
    Text {}
}
`.trim();
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const startCalls = result.unresolvedReferences.filter(
            (reference) => reference.referenceKind === 'calls' && reference.referenceName === 'service.start',
        );

        expect(result.nodes.find((node) => node.kind === 'method' && node.name === 'onClicked')).toBeDefined();
        expect(result.nodes.find((node) => node.kind === 'component' && node.name === 'Text')).toBeDefined();
        expect(startCalls).toHaveLength(1);
    });
});

describe('QmlExtractor — nested components', () => {
    it('keeps bound objects, siblings and a following function under one file root', () => {
        const src = `import QtQuick
Item {
  background: Rectangle {
    color: "red"
    MouseArea {
      onClicked: {
        if (enabled) { backend.refresh() }
      } }
  }
  contentItem: Item {}
  Text {}
  function refresh() {}
}`;
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const roots = result.nodes.filter((node) => node.kind === 'component' && node.isExported);
        const rectangle = result.nodes.find((node) => node.kind === 'component' && node.name === 'Rectangle');
        const mouse = result.nodes.find((node) => node.kind === 'component' && node.name === 'MouseArea');
        const content = result.nodes.find((node) => node.kind === 'component' && node.name === 'Item');
        const text = result.nodes.find((node) => node.kind === 'component' && node.name === 'Text');
        const refresh = result.nodes.find((node) => node.kind === 'function' && node.name === 'refresh');

        expect(result.errors).toEqual([]);
        expect(roots).toHaveLength(1);
        expect(rectangle).toMatchObject({ startLine: 3, endLine: 9 });
        expect(mouse).toMatchObject({ startLine: 5, endLine: 8 });
        for (const child of [rectangle, content, text, refresh]) {
            expect(child).toBeDefined();
            expect(result.edges).toContainEqual({ source: roots[0]!.id, target: child!.id, kind: 'contains' });
        }
        expect(result.edges).toContainEqual({ source: rectangle!.id, target: mouse!.id, kind: 'contains' });
    });

    it('closes multiple component frames on the same line', () => {
        const src = `import QtQuick
Item {
  Rectangle {
    MouseArea {
    } }
  Text {}
  function refresh() {}
}`;
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const root = result.nodes.find((node) => node.kind === 'component' && node.isExported);
        const text = result.nodes.find((node) => node.kind === 'component' && node.name === 'Text');
        const refresh = result.nodes.find((node) => node.kind === 'function' && node.name === 'refresh');

        expect(text).toBeDefined();
        expect(refresh).toBeDefined();
        for (const child of [text, refresh]) {
            expect(result.edges).toContainEqual({ source: root!.id, target: child!.id, kind: 'contains' });
        }
        expect(result.nodes.find((node) => node.name === 'Rectangle')?.endLine).toBe(5);
        expect(result.nodes.find((node) => node.name === 'MouseArea')?.endLine).toBe(5);
    });

  it('extracts nested component instantiation', () => {
    const src = `
import QtQuick
Item {
    MyCustomWidget {
        id: widget
    }
}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const comps = result.nodes.filter((n) => n.kind === 'component');
    // root + nested
    expect(comps.length).toBeGreaterThanOrEqual(2);
    expect(comps.some((c) => c.name === 'MyCustomWidget')).toBe(true);
  });

  it('emits a contains edge between parent and nested component', () => {
    const src = `
import QtQuick
Item {
    MyWidget {}
}
`.trim();
    const result = new QmlExtractor('ui/Root.qml', src).extract();
    const containsEdges = result.edges.filter((e) => e.kind === 'contains');
    expect(containsEdges.length).toBeGreaterThan(0);
  });

  it('emits an unresolved ref for user-defined nested types', () => {
    const src = `
import QtQuick
Item {
    MyBusinessWidget {}
}
`.trim();
    const result = new QmlExtractor('ui/Root.qml', src).extract();
    const typeRef = result.unresolvedReferences.find(
      (r) => r.referenceName === 'MyBusinessWidget',
    );
    expect(typeRef).toBeDefined();
  });

    it('keeps the component stack intact across grouped properties', () => {
        const src = `
import QtQuick
Item {
    anchors {
        left: parent.left
    }
    Text {
        onTextChanged: { afterText() }
    }
    function afterText() {}
}
`.trim();
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const roots = result.nodes.filter((node) => node.kind === 'component' && node.name === 'Main');
        const text = result.nodes.find((node) => node.kind === 'component' && node.name === 'Text');
        const handler = result.nodes.find((node) => node.kind === 'method' && node.name === 'onTextChanged');
        const afterText = result.nodes.find((node) => node.kind === 'function' && node.name === 'afterText');

        expect(roots).toHaveLength(1);
        expect(text).toBeDefined();
        expect(handler).toBeDefined();
        expect(afterText).toBeDefined();
        expect(result.edges).toContainEqual({ source: text!.id, target: handler!.id, kind: 'contains' });
    });

    it('qualifies calls through an unambiguous QML id with its component type', () => {
        const src = `
import Demo.Ui
Item {
    NativePanel {
        id: backend
    }
    function refreshPanel() {
        backend.refresh()
    }
}
`.trim();
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const ref = result.unresolvedReferences.find(
            (candidate) => candidate.referenceName === 'backend.refresh',
        );

        expect(ref?.referenceKind).toBe('calls');
        expect(ref?.candidates).toContain('qt.qml-id|backend|NativePanel|refresh');
    });
});

describe('QmlExtractor — brace on the next line', () => {
  const extract = (source: string) => new QmlExtractor('ui/Panel.qml', source).extract();
  const find = (nodes: ReturnType<typeof extract>['nodes'], kind: string, name: string) =>
    nodes.find((node) => node.kind === kind && node.name === name);

  it('finds the root component when its brace is on its own line', () => {
    const result = extract(`import QtQuick 2.15
Item
{
  id: root
  property int count: 0
  signal opened()
  function reset()
  {
    count = 0
  }
  onCountChanged:
  {
    opened()
  }
}
`);
    const root = find(result.nodes, 'component', 'Panel');
    expect(root).toMatchObject({ startLine: 2, endLine: 16 });
    expect(find(result.nodes, 'property', 'count')).toBeDefined();
    expect(find(result.nodes, 'method', 'opened')).toBeDefined();
    expect(find(result.nodes, 'function', 'reset') ?? find(result.nodes, 'method', 'reset')).toBeDefined();
    expect(result.errors).toHaveLength(0);
  });

  it('keeps the nested component and its line when the brace is on the next line', () => {
    const result = extract(`import QtQuick 2.15
Item
{
  Rectangle
  {
    id: box
  }
  Text { text: "x" }
}
`);
    const nested = result.nodes.find((node) => node.kind === 'component' && node.name === 'Rectangle');
    expect(nested).toMatchObject({ startLine: 4, endLine: 7 });
    expect(result.nodes.find((node) => node.kind === 'component' && node.name === 'Text')?.startLine).toBe(8);
  });

  it('reads an enum whose brace is on the next line', () => {
    const result = extract(`import QtQuick 2.15
Item
{
  enum Mode
  {
    Fast,
    Slow
  }
}
`);
    expect(result.nodes.filter((node) => node.kind === 'enum_member').map((node) => node.name).sort()).toEqual(['Fast', 'Slow']);
  });

  it('does not move a brace that sits in a string or a comment', () => {
    const source = `import QtQuick 2.15
Item {
  property string open: "a"
  // comment
  /* block
  { */
  property string brace: "{"
}
`;
    const result = extract(source);
    expect(find(result.nodes, 'component', 'Panel')).toMatchObject({ startLine: 2 });
    expect(find(result.nodes, 'property', 'open')).toBeDefined();
    expect(find(result.nodes, 'property', 'brace')).toBeDefined();
    expect(result.errors).toHaveLength(0);
  });

  it('warns when a file has code but no root component', () => {
    const result = extract('import QtQuick 2.15\nthis is not qml\n');
    expect(result.errors).toEqual([expect.objectContaining({ severity: 'warning', code: 'parse_error' })]);
  });

  it('does not warn on an import-only or empty file', () => {
    expect(extract('import QtQuick 2.15\n').errors).toHaveLength(0);
    expect(extract('// nothing\n').errors).toHaveLength(0);
  });
});

describe('TreeSitterExtractor — onTree hook', () => {
  it('hands the parsed tree to the embedder once, before it is freed', () => {
    const seen: string[] = [];
    const extractor = new TreeSitterExtractor('body.js', 'const a = b.c;', 'javascript', {
      onTree: (root) => seen.push(`${root.type}:${root.descendantsOfType('member_expression').length}`),
    });
    extractor.extract();
    expect(seen).toEqual(['program:1']);
  });

  it('annotates a member call through a QML id from the tree the extractor already parsed', () => {
    const result = new QmlExtractor('ui/Body.qml', `import QtQuick 2.15
Item {
  NativePanel {
    id: backend
  }
  function run() {
    const shadowed = 1
    return backend.value() + shadowed
  }
}
`).extract();
    const ref = result.unresolvedReferences.find((candidate) => candidate.referenceName === 'backend.value');
    expect(ref?.candidates).toEqual(['qt.qml-id|backend|NativePanel|value']);
  });
});

describe('QmlExtractor — error resilience', () => {
  it('does not throw on empty source', () => {
    const result = new QmlExtractor('ui/Empty.qml', '').extract();
    expect(result.errors).toHaveLength(0);
  });

  it('does not throw on malformed QML', () => {
    const src = 'import QtQuick\nItem { unclosed {';
    expect(() => new QmlExtractor('ui/Bad.qml', src).extract()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Qt framework resolver — C++ extraction
// ---------------------------------------------------------------------------

describe('qtResolver — detection', () => {
  it('detects project with .qml files', () => {
    const ctx = {
      getAllFiles: () => ['src/main.cpp', 'ui/Main.qml'],
      readFile: () => null,
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/tmp',
      getImportMappings: () => [],
    };
    // @ts-expect-error — minimal mock
    expect(qtResolver.detect(ctx)).toBe(true);
  });

  it('detects project with QObject includes', () => {
    const ctx = {
      getAllFiles: () => ['src/widget.h'],
      readFile: (f: string) => (f === 'src/widget.h' ? '#include <QObject>\nclass Foo {};' : null),
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/tmp',
      getImportMappings: () => [],
    };
    // @ts-expect-error — minimal mock
    expect(qtResolver.detect(ctx)).toBe(true);
  });
});

describe('qtResolver — C++ signal extraction', () => {
  const QT_CPP = `
#include <QObject>

class Counter : public QObject {
    Q_OBJECT
public:
    explicit Counter(QObject *parent = nullptr);
    int value() const;
signals:
    void valueChanged(int newValue);
    void thresholdReached();
public slots:
    void setValue(int value);
    void reset();
};
`.trim();

  it('extracts signal methods from signals: section', () => {
    const { nodes } = qtResolver.extract!('src/counter.h', QT_CPP);
    const signals = nodes.filter((n) => n.signature?.includes('signal'));
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.some((n) => n.name === 'valueChanged')).toBe(true);
    expect(signals.some((n) => n.name === 'thresholdReached')).toBe(true);
  });

  it('extracts slot methods from slots: section', () => {
    const { nodes } = qtResolver.extract!('src/counter.h', QT_CPP);
    const slots = nodes.filter((n) => n.signature?.includes('slot'));
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(slots.some((n) => n.name === 'setValue')).toBe(true);
    expect(slots.some((n) => n.name === 'reset')).toBe(true);
  });

  it('returns no nodes for non-Qt C++ files', () => {
    const src = `
#include <iostream>
class Foo { void bar() {} };
`.trim();
    const { nodes } = qtResolver.extract!('src/foo.cpp', src);
    expect(nodes).toHaveLength(0);
  });
});

describe('qtResolver — claimsReference', () => {
  const ref = (language: string) => ({
    fromNodeId: 'n', referenceName: 'service.refresh', referenceKind: 'calls' as const,
    line: 1, column: 0, filePath: `f.${language}`, language: language as never,
  });

  it('claims a dotted member access from QML only', () => {
    expect(qtResolver.claimsReference!('service.refresh', ref('qml'))).toBe(true);
    expect(qtResolver.claimsReference!('service.refresh', ref('typescript'))).toBe(false);
    expect(qtResolver.claimsReference!('service.refresh', ref('python'))).toBe(false);
    expect(qtResolver.claimsReference!('service.refresh')).toBe(false);
    expect(qtResolver.claimsReference!('refresh', ref('qml'))).toBe(false);
  });
});

describe('qtResolver — Q_PROPERTY extraction', () => {
  const QT_CPP = `
#include <QObject>
class Widget : public QObject {
    Q_OBJECT
    Q_PROPERTY(int count READ count WRITE setCount NOTIFY countChanged)
    Q_PROPERTY(QString title READ title NOTIFY titleChanged)
};
`.trim();

  it('extracts Q_PROPERTY as property nodes', () => {
    const { nodes } = qtResolver.extract!('src/widget.h', QT_CPP);
    const props = nodes.filter((n) => n.kind === 'property');
    expect(props.length).toBeGreaterThanOrEqual(2);
    expect(props.some((n) => n.name === 'count')).toBe(true);
    expect(props.some((n) => n.name === 'title')).toBe(true);
  });

  it('emits references to READ, WRITE, NOTIFY from Q_PROPERTY', () => {
    const { references } = qtResolver.extract!('src/widget.h', QT_CPP);
    const refNames = references.map((r) => r.referenceName);
    expect(refNames).toContain('count');
    expect(refNames).toContain('setCount');
    expect(refNames).toContain('countChanged');
  });
});

describe('qtResolver — connect() edge extraction', () => {
  const SRC_MACRO = `
#include <QObject>
void setup(Counter *c, Display *d) {
    QObject::connect(c, SIGNAL(valueChanged(int)), d, SLOT(displayValue(int)));
}
`.trim();

  it('extracts SIGNAL/SLOT connect() references', () => {
    const { references } = qtResolver.extract!('src/setup.cpp', SRC_MACRO);
    const refNames = references.map((r) => r.referenceName);
    expect(refNames).toContain('valueChanged');
    expect(refNames).toContain('displayValue');
  });

  const SRC_PTR = `
#include <QObject>
void setup(Counter *c, Display *d) {
    connect(c, &Counter::valueChanged, d, &Display::displayValue);
}
`.trim();

  it('extracts pointer-style connect() references', () => {
    const { references } = qtResolver.extract!('src/setup.cpp', SRC_PTR);
    const refNames = references.map((r) => r.referenceName);
    expect(refNames).toContain('valueChanged');
    expect(refNames).toContain('displayValue');
  });
});

describe('qtResolver — setContextProperty extraction', () => {
    it('records a literal context property backed by a typed pointer', () => {
        const src = `
#include <QQmlContext>
void expose(QQmlContext *context, Demo::ReportBridge *service) {
    context->setContextProperty("reportService", service);
}
`.trim();
        const { nodes } = qtResolver.extract!('src/bootstrap.cpp', src);
        expect(nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'variable',
                name: 'reportService',
                signature: 'qt.context-property|reportService|Demo::ReportBridge',
            }),
        ]));
    });

    it('records a context property backed by an auto new expression', () => {
        const src = `
    #include <QQmlContext>
    void expose(QQmlApplicationEngine &engine) {
      auto service = new Demo::ReportBridge();
      engine.rootContext()->setContextProperty("reportService", service);
    }
    `.trim();
        const { nodes } = qtResolver.extract!('src/bootstrap.cpp', src);
        expect(nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'variable',
                name: 'reportService',
                signature: 'qt.context-property|reportService|Demo::ReportBridge',
            }),
        ]));
    });

    it('ignores dynamic values and untyped receivers', () => {
        const src = `
#include <QQmlContext>
void expose(OtherContext *context, Demo::ReportBridge *service) {
    context->setContextProperty("wrongReceiver", service);
    engine.rootContext()->setContextProperty("dynamicValue", makeService());
}
`.trim();
        const { nodes } = qtResolver.extract!('src/bootstrap.cpp', src);
        expect(nodes.filter((node) => node.signature?.startsWith('qt.context-property|'))).toEqual([]);
    });

    it('does not borrow receiver and value types from another function scope', () => {
        const src = `
#include <QQmlContext>
void typedElsewhere(QQmlContext *context, Demo::ReportBridge *service) {}
void expose() {
    auto context = makeOtherContext();
    auto service = makeOtherService();
    context->setContextProperty("reportService", service);
}
`.trim();
        const { nodes } = qtResolver.extract!('src/bootstrap.cpp', src);
        expect(nodes.filter((node) => node.signature?.startsWith('qt.context-property|'))).toEqual([]);
    });
});

describe('qtResolver — QML signal handler resolution', () => {
    it('resolves a handler signal only within its declared owner', () => {
    const signalNode = {
      id: 'sig-1',
      kind: 'method' as const,
      name: 'fooChanged',
        qualifiedName: 'ui/Widget.qml::fooChanged',
        filePath: 'ui/Widget.qml',
        language: 'qml' as const,
      startLine: 10,
      endLine: 10,
      startColumn: 0,
      endColumn: 40,
      updatedAt: Date.now(),
      signature: 'signal fooChanged()',
    };

    const ctx = {
      getAllFiles: () => ['ui/Main.qml', 'src/widget.h'],
      readFile: () => null,
        getNodesInFile: () => [],
      getNodesByName: (name: string) => (name === 'fooChanged' ? [signalNode] : []),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/tmp',
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'handler-1',
        referenceName: 'fooChanged',
        referenceKind: 'references' as const,
      line: 5,
      column: 4,
      filePath: 'ui/Main.qml',
      language: 'qml' as const,
        candidates: ['Widget::fooChanged'],
    };

    const resolved = qtResolver.resolve(ref, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.targetNodeId).toBe('sig-1');
    expect(resolved!.resolvedBy).toBe('framework');
  });

    it('does not resolve a same-named signal from another QML owner', () => {
        const otherSignal = {
            id: 'sig-other',
            kind: 'method' as const,
            name: 'clicked',
            qualifiedName: 'ui/OtherButton.qml::clicked',
            filePath: 'ui/OtherButton.qml',
            language: 'qml' as const,
            startLine: 3,
            endLine: 3,
            startColumn: 0,
            endColumn: 20,
            updatedAt: Date.now(),
            signature: 'signal clicked()',
        };
        const ctx = {
            getAllFiles: () => ['ui/Main.qml', 'ui/OtherButton.qml'],
            readFile: () => null,
            getNodesInFile: () => [],
            getNodesByName: (name: string) => (name === 'clicked' ? [otherSignal] : []),
            getNodesByQualifiedName: () => [],
            getNodesByKind: () => [],
            getNodesByLowerName: () => [],
            fileExists: () => false,
            getProjectRoot: () => '/tmp',
            getImportMappings: () => [],
        };
        const ref = {
            fromNodeId: 'handler-1',
            referenceName: 'clicked',
            referenceKind: 'references' as const,
            line: 5,
            column: 4,
            filePath: 'ui/Main.qml',
            language: 'qml' as const,
            candidates: ['MainBarButton::clicked'],
        };

        expect(qtResolver.resolve(ref, ctx)).toBeNull();
    });

  it('does not resolve non-handler QML references', () => {
    const ctx = {
      getAllFiles: () => [],
      readFile: () => null,
        getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/tmp',
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'node-1',
      referenceName: 'someFunction',
      referenceKind: 'calls' as const,
      line: 3,
      column: 0,
      filePath: 'ui/Main.qml',
      language: 'qml' as const,
    };

    const resolved = qtResolver.resolve(ref, ctx);
    expect(resolved).toBeNull();
  });
});

describe('qtResolver — QML id receiver resolution', () => {
    const methodNode = (id: string, owner: string) => ({
        id,
        kind: 'method' as const,
        name: 'refresh',
        qualifiedName: `src/${owner}.h::${owner}::refresh`,
        filePath: `src/${owner}.h`,
        language: 'cpp' as const,
        startLine: 4,
        endLine: 4,
        startColumn: 0,
        endColumn: 30,
        updatedAt: Date.now(),
        signature: 'invokable refresh()',
    });

    const contextFor = (methods: ReturnType<typeof methodNode>[]) => ({
        getAllFiles: () => ['ui/Main.qml'],
        readFile: () => null,
        getNodesInFile: () => [],
        getNodesByName: (name: string) => (name === 'refresh' ? methods : []),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        getNodesByLowerName: () => [],
        fileExists: () => false,
        getProjectRoot: () => '/tmp',
        getImportMappings: () => [],
    });

    const ref = {
        fromNodeId: 'function-1',
        referenceName: 'backend.refresh',
        referenceKind: 'calls' as const,
        line: 8,
        column: 8,
        filePath: 'ui/Main.qml',
        language: 'qml' as const,
        candidates: ['qt.qml-id|backend|NativePanel|refresh'],
    };

    it('resolves only the method owned by the QML id type', () => {
        const context = contextFor([
            methodNode('wrong-method', 'OtherPanel'),
            methodNode('right-method', 'NativePanel'),
        ]);

        expect(qtResolver.resolve(ref, context)?.targetNodeId).toBe('right-method');
    });

    it('does not guess when the QML id type has no matching method', () => {
        const context = contextFor([methodNode('wrong-method', 'OtherPanel')]);

        expect(qtResolver.resolve(ref, context)).toBeNull();
    });
});

describe('QmlExtractor — context property calls', () => {
    it('checks parameters and locals before annotating an existing QML id', () => {
        const src = `import QtQuick
Item {
  NativePanel {
    id: backend
  }
  function run(backend) {
    backend.refresh()
  }
  function localRun() {
    const backend = localService
    backend.refresh()
  }
  function refreshPanel() {
    backend.refresh()
  }
}`;
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        for (const name of ['run', 'localRun', 'refreshPanel']) {
            const owner = result.nodes.find((node) => node.kind === 'function' && node.name === name);
            const ref = result.unresolvedReferences.find(
                (reference) => reference.fromNodeId === owner?.id && reference.referenceName === 'backend.refresh',
            );
            expect(ref).toBeDefined();
            if (name === 'refreshPanel') {
                expect(ref?.candidates).toEqual(['qt.qml-id|backend|NativePanel|refresh']);
            } else {
                expect(ref?.candidates ?? []).not.toContain('qt.qml-id|backend|NativePanel|refresh');
                expect(ref?.candidates ?? []).not.toContain('qt.context-property|backend|refresh');
            }
        }
    });

    it('does not annotate duplicate ids even when they share a type', () => {
        const src = `import QtQuick
Item {
  NativePanel {
    id: backend
  }
  NativePanel {
    id: backend
  }
  function run() { backend.refresh() }
}`;
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const ref = result.unresolvedReferences.find((reference) => reference.referenceName === 'backend.refresh');

        expect(ref).toBeDefined();
        expect(ref?.candidates ?? []).not.toContain('qt.qml-id|backend|NativePanel|refresh');
        expect(ref?.candidates ?? []).not.toContain('qt.context-property|backend|refresh');
    });

    it('marks an unshadowed dotted call as a possible Qt context property', () => {
        const src = `
import QtQuick
Item {
    function updateReport() {
        reportService.refresh()
    }
}
`.trim();
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const ref = result.unresolvedReferences.find(
            (candidate) => candidate.referenceName === 'reportService.refresh',
        );
        expect(ref?.candidates).toContain('qt.context-property|reportService|refresh');
    });

    it('does not mark a function parameter as a context property', () => {
        const src = `
import QtQuick
Item {
    function updateReport(reportService) {
        reportService.refresh()
    }
}
`.trim();
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const ref = result.unresolvedReferences.find(
            (candidate) => candidate.referenceName === 'reportService.refresh',
        );
        expect(ref?.candidates ?? []).not.toContain('qt.context-property|reportService|refresh');
    });
});

describe('QmlExtractor — Component.createObject', () => {
    it('preserves the actual Component type independently of a root id owner', () => {
        const src = `import QtQuick
Component {
  id: panelFactory
  ReportPanel {
    function createPanel(parentItem) {
      return panelFactory.createObject(parentItem)
    }
  }
}`;
        const result = new QmlExtractor('ui/PanelFactory.qml', src).extract();
        const caller = result.nodes.find((node) => node.name === 'createPanel');
        const panel = result.nodes.find((node) => node.kind === 'component' && node.name === 'ReportPanel');

        expect(caller).toBeDefined();
        expect(panel).toBeDefined();
        expect(result.edges).toContainEqual({ source: caller!.id, target: panel!.id, kind: 'instantiates' });
        expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
            referenceName: 'panelFactory.createObject', candidates: ['qt.qml-id|panelFactory|PanelFactory|createObject'],
        }));
    });

    it('links a local component factory call to its single child definition', () => {
        const src = `
import QtQuick
Item {
    Component {
        id: panelFactory
        ReportPanel {}
    }
    function createPanel(parentItem) {
        return panelFactory.createObject(parentItem)
    }
}
`.trim();
        const result = new QmlExtractor('ui/Main.qml', src).extract();
        const caller = result.nodes.find((node) => node.kind === 'function' && node.name === 'createPanel');
        const panel = result.nodes.find((node) => node.kind === 'component' && node.name === 'ReportPanel');
        const root = result.nodes.find((node) => node.kind === 'component' && node.name === 'Main');

        expect(caller).toBeDefined();
        expect(panel).toBeDefined();
        expect(root).toBeDefined();
        expect(result.edges).toContainEqual({ source: root!.id, target: caller!.id, kind: 'contains' });
        expect(result.edges).toContainEqual({
            source: caller!.id,
            target: panel!.id,
            kind: 'instantiates',
        });
    });
});

// ---------------------------------------------------------------------------
// Qt C++ preParse — blankQtMacros
// ---------------------------------------------------------------------------

describe('blankQtMacros', () => {
  it('blanks Q_OBJECT to same-length spaces', () => {
    const src = 'class Foo : public QObject {\n    Q_OBJECT\npublic:\n};\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('Q_OBJECT');
    // Byte offset preserved: Q_OBJECT is 8 chars → 8 spaces
    expect(result.indexOf('        \n')).toBeGreaterThan(0);
    expect(result.length).toBe(src.length);
  });

  it('blanks Q_INVOKABLE', () => {
    const src = '    Q_INVOKABLE void doThing();\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('Q_INVOKABLE');
    expect(result.length).toBe(src.length);
  });

    it('rewrites signals: to a valid access specifier without changing length', () => {
    const src = 'signals:\n    void clicked();\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('signals');
      expect(result).toContain('public :');
    expect(result.length).toBe(src.length);
  });

    it('rewrites Q_SIGNALS: to a valid access specifier without changing length', () => {
    const src = 'Q_SIGNALS:\n    void pressed();\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('Q_SIGNALS');
      expect(result).toContain('public   :');
      expect(result.length).toBe(src.length);
  });

    it('blanks bare slots: without lengthening the header', async () => {
        const src = 'class Foo {\nslots:\n    void update() {}\n};\n';
        const result = blankQtMacros(src);
        expect(result).toBe(src.replace('slots:', '      '));
        expect(result.length).toBe(src.length);
        const { getParser } = await import('../src/extraction/grammars');
        await loadGrammarsForLanguages(['cpp']);
        const tree = getParser('cpp')!.parse(result)!;
        try {
            expect(tree.rootNode.hasError).toBe(false);
            const method = tree.rootNode.descendantsOfType('function_definition')[0]!;
            expect(method.startIndex).toBe(src.indexOf('void update'));
            expect(method.startPosition).toEqual({ row: 2, column: 4 });
        } finally {
            tree.delete();
        }
    });

    it.each(['public', 'private', 'protected'])('preserves %s slots and Q_SLOTS header coordinates', (access) => {
        for (const alias of ['slots', 'Q_SLOTS']) {
            const src = `class Foo {\r\n${access} ${alias}:\r\n    void update();\r\n};\r\n`;
        const result = blankQtMacros(src);
            expect(result).toBe(src.replace(alias, ' '.repeat(alias.length)));
            expect(result.length).toBe(src.length);
            expect(Buffer.byteLength(result)).toBe(Buffer.byteLength(src));
        }
    });

    it.each(['Q_NAMESPACE', 'Q_REQUIRED_RESULT', 'Q_DECL_OVERRIDE', 'Q_DECL_FINAL', 'Q_DECL_NOEXCEPT', 'Q_DECL_DEPRECATED', 'Q_DECL_DEPRECATED_X', 'Q_DECL_UNUSED', 'Q_DECL_PURE_VIRTUAL'])('recognizes %s without another Qt token', (macro) => {
        expect(blankQtMacros(`${macro}\n`)).toBe(`${' '.repeat(macro.length)}\n`);
    });

    it('leaves Qt macro text in ordinary literals and comments unchanged', () => {
        const src = [
            'const auto text = u8"Q_OBJECT QML_NAMED_ELEMENT(Foo) emit changed() \\" Q_GADGET";',
            "const auto quote = L'\\\'';",
            '// Q_NAMESPACE QML_UNCREATABLE("reason")',
            '/*\nQ_OBJECT\nsignals:\npublic slots:\nQML_ELEMENT\n*/',
        ].join('\r\n');
        expect(blankQtMacros(src)).toBe(src);
    });

    it.each(['R', 'LR', 'u8R', 'uR', 'UR'])('leaves %s raw literal macro text unchanged', (prefix) => {
        const literal = `${prefix}"TAG(\r\nQ_OBJECT\r\nslots:\r\nQML_UNCREATABLE(")")\r\n)TAG"`;
        const src = `const auto text = ${literal};\r\nQ_OBJECT\r\n`;
        expect(blankQtMacros(src)).toBe(`const auto text = ${literal};\r\n        \r\n`);
    });

    it('exports a non-code scan mask preserving UTF-16 and newline offsets', async () => {
        const { maskCppNonCode } = await import('../src/extraction/languages/c-cpp');
        const hidden = [
            '// comment \\\r\nQ_OBJECT',
            '/* \u00e9 \u{1f680}\r\nQ_NAMESPACE */',
            'u8"escaped \\" Q_OBJECT"',
            "L'\\\''",
            'u8R"TAG(\r\nQML_ELEMENT\n)TAG"',
        ].join('\n');
        const tail = "\nconst auto number = 1'000 + 0xA'B;\nQ_OBJECT\n";
        expect(maskCppNonCode(hidden + tail)).toBe(hidden.replace(/[^\r\n]/g, ' ') + tail);
        expect(blankQtMacros(hidden + tail)).toBe(hidden + tail.replace('Q_OBJECT', '        '));
    });

    it('preserves non-Qt identifiers and blank lines before access headers', () => {
        const src = 'class Foo {\n\npublic slots:\n    int Q_OBJECT_value;\n    int signalsCount;\n};\n';
        expect(blankQtMacros(src)).toBe(src.replace('slots', '     '));
    });

    it('leaves ordinary signals and slots expressions unchanged', () => {
        const src = 'void f() { auto member = signals::value; auto result = ok ? slots : 0; }\n';
        expect(blankQtMacros(src)).toBe(src);
    });

    it('blanks emit before a signal invocation', () => {
        const src = 'void refresh() { emit changed(); }\n';
        expect(blankQtMacros(src)).toContain('void refresh() {      changed(); }');
    });

    it('blanks QML_FOREIGN with its argument', () => {
        const src = 'QML_FOREIGN(ForeignType)\n';
        const result = blankQtMacros(src);
        expect(result).not.toContain('QML_FOREIGN');
    expect(result.length).toBe(src.length);
  });

  it('passes through non-Qt source unchanged', () => {
    const src = '#include <iostream>\nint main() { return 0; }\n';
    const result = blankQtMacros(src);
    expect(result).toBe(src);
  });
});

// ---------------------------------------------------------------------------
// QmlExtractor — enum declarations
// ---------------------------------------------------------------------------

describe('QmlExtractor — enum declarations', () => {
  it('extracts an enum node', () => {
    const src = `
import QtQuick
Item {
    enum Status {
        Active,
        Inactive,
        Pending
    }
}
`.trim();
    const result = new QmlExtractor('ui/Widget.qml', src).extract();
    const enumNode = result.nodes.find((n) => n.kind === 'enum' && n.name === 'Status');
    expect(enumNode).toBeDefined();
    expect(enumNode!.language).toBe('qml');
  });

  it('extracts enum_member nodes', () => {
    const src = `
import QtQuick
Item {
    enum Priority {
        Low,
        Medium,
        High
    }
}
`.trim();
    const result = new QmlExtractor('ui/Task.qml', src).extract();
    const members = result.nodes.filter((n) => n.kind === 'enum_member');
    expect(members.length).toBeGreaterThanOrEqual(3);
    expect(members.some((m) => m.name === 'Low')).toBe(true);
    expect(members.some((m) => m.name === 'Medium')).toBe(true);
    expect(members.some((m) => m.name === 'High')).toBe(true);
  });

  it('emits a contains edge from parent component to enum node', () => {
    const src = `
import QtQuick
Item {
    enum Mode { Read, Write }
}
`.trim();
    const result = new QmlExtractor('ui/Doc.qml', src).extract();
    const enumNode = result.nodes.find((n) => n.kind === 'enum');
    const rootComp = result.nodes.find((n) => n.kind === 'component');
    expect(enumNode).toBeDefined();
    const containsEdge = result.edges.find(
      (e) => e.kind === 'contains' && e.source === rootComp!.id && e.target === enumNode!.id,
    );
    expect(containsEdge).toBeDefined();
  });

  it('does not confuse enum members with nested component types', () => {
    const src = `
import QtQuick
Item {
    enum Color { Red, Green, Blue }
    Rectangle { color: "red" }
}
`.trim();
    const result = new QmlExtractor('ui/Palette.qml', src).extract();
    // Rectangle is a built-in — not an unresolved ref
    const typeRef = result.unresolvedReferences.find((r) => r.referenceName === 'Red');
    expect(typeRef).toBeUndefined();
    const enumNode = result.nodes.find((n) => n.kind === 'enum');
    expect(enumNode).toBeDefined();
  });

  it('extracts qualified enum member names', () => {
    const src = `
import QtQuick
Item {
    enum Direction { Up, Down, Left, Right }
}
`.trim();
    const result = new QmlExtractor('ui/Arrow.qml', src).extract();
    const member = result.nodes.find((n) => n.kind === 'enum_member' && n.name === 'Up');
    expect(member).toBeDefined();
    expect(member!.qualifiedName).toContain('Direction');
  });

    it('links an embedded JS access to a declared local enum member', () => {
        const src = `
import QtQuick
Item {
    enum Status { Ready, Busy }
    function initialStatus() {
        return Status.Ready
    }
}
`.trim();
        const result = new QmlExtractor('ui/Widget.qml', src).extract();
        const fn = result.nodes.find((node) => node.kind === 'function' && node.name === 'initialStatus');
        const member = result.nodes.find(
            (node) => node.kind === 'enum_member' && node.qualifiedName === 'ui/Widget.qml::Status::Ready',
        );

        expect(fn).toBeDefined();
        expect(member).toBeDefined();
        expect(result.edges).toContainEqual({ source: fn!.id, target: member!.id, kind: 'references' });
    });

    it('extracts qualified enum accesses from property bindings', () => {
        const src = `
import QtQuick
Item {
    enum Status { Ready, Busy }
    property int initialStatus: Status.Ready
    property int orientation: Qt.Vertical
    property int ordinaryValue: model.value
}
`.trim();
        const result = new QmlExtractor('ui/Widget.qml', src).extract();
        const property = result.nodes.find((node) => node.kind === 'property' && node.name === 'initialStatus');
        const member = result.nodes.find(
            (node) => node.kind === 'enum_member' && node.qualifiedName === 'ui/Widget.qml::Status::Ready',
        );

        expect(result.edges).toContainEqual({ source: property!.id, target: member!.id, kind: 'references' });
        expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({
            fromNodeId: result.nodes.find((node) => node.name === 'orientation')!.id,
            referenceName: 'Vertical',
            referenceKind: 'references',
            candidates: ['qt.enum-member|Qt|Vertical'],
        }));
        expect(result.unresolvedReferences).not.toContainEqual(expect.objectContaining({
            referenceName: 'value',
            candidates: ['qt.enum-member|model|value'],
        }));
    });

    it('does not guess between duplicate local enum members', () => {
        const src = `
import QtQuick
Item {
    enum Status { Ready }
    component Child: Item {
        enum Status { Ready }
    }
    function initialStatus() {
        return Status.Ready
    }
}
`.trim();
        const result = new QmlExtractor('ui/Widget.qml', src).extract();
        const fn = result.nodes.find((node) => node.kind === 'function' && node.name === 'initialStatus');
        const memberIds = new Set(
            result.nodes.filter((node) => node.kind === 'enum_member' && node.name === 'Ready').map((node) => node.id),
        );
        expect(result.edges.filter(
            (edge) => edge.source === fn!.id && edge.kind === 'references' && memberIds.has(edge.target),
        )).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// QmlExtractor — inline components (QML 6)
// ---------------------------------------------------------------------------

describe('QmlExtractor — inline components', () => {
  it('extracts an inline component declaration', () => {
    const src = `
import QtQuick
ApplicationWindow {
    component MyButton: Rectangle {
        property string label: ""
        signal clicked()
    }
}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const inlineComp = result.nodes.find((n) => n.kind === 'component' && n.name === 'MyButton');
    expect(inlineComp).toBeDefined();
    expect(inlineComp!.language).toBe('qml');
  });

  it('marks inline component as exported', () => {
    const src = `
import QtQuick
Item {
    component Header: Rectangle {}
}
`.trim();
    const result = new QmlExtractor('ui/Layout.qml', src).extract();
    const header = result.nodes.find((n) => n.name === 'Header' && n.kind === 'component');
    expect(header).toBeDefined();
    expect(header!.isExported).toBe(true);
  });

  it('emits a references edge to the base type', () => {
    const src = `
import QtQuick
Item {
    component Badge: Rectangle {}
}
`.trim();
    const result = new QmlExtractor('ui/Badge.qml', src).extract();
    // Rectangle is a built-in — but we still emit the extends reference for traceability
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceName === 'Rectangle',
    );
    expect(ref).toBeDefined();
    expect(ref!.referenceKind).toBe('references');
  });

  it('captures properties inside inline component', () => {
    const src = `
import QtQuick
Item {
    component MyLabel: Text {
        property color textColor: "black"
        signal tapped()
    }
}
`.trim();
    const result = new QmlExtractor('ui/Labels.qml', src).extract();
    const prop = result.nodes.find((n) => n.kind === 'property' && n.name === 'textColor');
    const sig = result.nodes.find((n) => n.kind === 'method' && n.name === 'tapped');
    expect(prop).toBeDefined();
    expect(sig).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// QmlExtractor — attached type handlers
// ---------------------------------------------------------------------------

describe('QmlExtractor — attached type handlers', () => {
  it('extracts Component.onCompleted handler', () => {
    const src = `
import QtQuick
Item {
    Component.onCompleted: console.log("ready")
}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const handler = result.nodes.find(
      (n) => n.kind === 'method' && n.name === 'Component.onCompleted',
    );
    expect(handler).toBeDefined();
    expect(handler!.signature).toContain('Component.onCompleted');
  });

  it('extracts Keys.onPressed handler', () => {
    const src = `
import QtQuick
Item {
    Keys.onPressed: (event) => { event.accepted = true }
}
`.trim();
    const result = new QmlExtractor('ui/Input.qml', src).extract();
    const handler = result.nodes.find(
      (n) => n.kind === 'method' && n.name === 'Keys.onPressed',
    );
    expect(handler).toBeDefined();
  });

    it('emits a reference association from attached handler to the signal name', () => {
    const src = `
import QtQuick
Item {
    Component.onCompleted: doInit()
}
`.trim();
    const result = new QmlExtractor('ui/Main.qml', src).extract();
    const ref = result.unresolvedReferences.find((r) => r.referenceName === 'completed');
    expect(ref).toBeDefined();
      expect(ref!.referenceKind).toBe('references');
  });

    it('does not emit project references for built-in attached types', () => {
    const src = `
import QtQuick
Item {
    Keys.onReturnPressed: submit()
}
`.trim();
    const result = new QmlExtractor('ui/Form.qml', src).extract();
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceName === 'Keys' && r.referenceKind === 'references',
    );
      expect(ref).toBeUndefined();
  });

    it('extracts calls from an arrow-function handler body', () => {
        const src = `
import QtQuick
Item {
    CustomPanel {
        onSaved: (value) => {
            publishValue(value)
        }
    }
}
`.trim();
        const result = new QmlExtractor('ui/Form.qml', src).extract();
        const handler = result.nodes.find((n) => n.name === 'onSaved');
        const call = result.unresolvedReferences.find(
            (r) => r.fromNodeId === handler?.id && r.referenceName === 'publishValue',
        );
        expect(handler).toBeDefined();
        expect(call?.referenceKind).toBe('calls');
  });

  it('emits a contains edge from parent component to attached handler', () => {
    const src = `
import QtQuick
Item {
    Component.onDestruction: cleanup()
}
`.trim();
    const result = new QmlExtractor('ui/Widget.qml', src).extract();
    const handler = result.nodes.find((n) => n.name === 'Component.onDestruction');
    const comp = result.nodes.find((n) => n.kind === 'component');
    expect(handler).toBeDefined();
    const edge = result.edges.find(
      (e) => e.kind === 'contains' && e.source === comp!.id && e.target === handler!.id,
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// qtResolver — QML_NAMED_ELEMENT extraction
// ---------------------------------------------------------------------------

describe('qtResolver — QML_NAMED_ELEMENT extraction', () => {
  const QT_CPP_NAMED = `
#include <QObject>
#include <QtQml>

class PrivateCounter : public QObject {
    Q_OBJECT
    QML_NAMED_ELEMENT(Counter)
public:
    explicit PrivateCounter(QObject *parent = nullptr);
signals:
    void countChanged();
};
`.trim();

  it('extracts a component alias node with the QML name', () => {
    const { nodes } = qtResolver.extract!('src/counter.h', QT_CPP_NAMED);
    const alias = nodes.find((n) => n.kind === 'component' && n.name === 'Counter');
    expect(alias).toBeDefined();
    expect(alias!.signature).toContain('QML_NAMED_ELEMENT(Counter)');
      expect(alias!.signature).toContain('PrivateCounter');
  });

  it('component alias node is in the same file as the C++ class', () => {
    const { nodes } = qtResolver.extract!('src/counter.h', QT_CPP_NAMED);
    const alias = nodes.find((n) => n.kind === 'component' && n.name === 'Counter');
    expect(alias!.filePath).toBe('src/counter.h');
  });

    it('emits a references relation from the alias to the C++ owner', () => {
    const { references } = qtResolver.extract!('src/counter.h', QT_CPP_NAMED);
      const ref = references.find((r) => r.referenceName === 'PrivateCounter');
    expect(ref).toBeDefined();
  });

  it('detects Qt project via QML_ELEMENT pattern', () => {
    const ctx = {
      getAllFiles: () => ['src/widget.h'],
      readFile: (f: string) =>
        f === 'src/widget.h'
          ? 'class Foo {\n    QML_ELEMENT\n};\n'
          : null,
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      getProjectRoot: () => '/tmp',
      getImportMappings: () => [],
    };
    // @ts-expect-error — minimal mock
    expect(qtResolver.detect(ctx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// qtResolver — qmlRegisterType extraction
// ---------------------------------------------------------------------------

describe('qtResolver — qmlRegisterType extraction', () => {
  const SRC_SAME_NAME = `
#include <QObject>
#include <QtQml>
class Counter : public QObject { Q_OBJECT };

void registerTypes() {
    qmlRegisterType<Counter>("com.example", 1, 0, "Counter");
}
`.trim();

  const SRC_DIFF_NAME = `
#include <QObject>
#include <QtQml>
class InternalCounter : public QObject { Q_OBJECT };

void registerTypes() {
    qmlRegisterType<InternalCounter>("com.example", 1, 0, "Counter");
}
`.trim();

    it('creates a component alias when QML name equals C++ class name', () => {
    const { nodes } = qtResolver.extract!('src/register.cpp', SRC_SAME_NAME);
    const aliases = nodes.filter((n) => n.kind === 'component' && n.name === 'Counter');
      expect(aliases).toHaveLength(1);
      expect(aliases[0]!.signature).toContain('qmlRegisterType<Counter>');
  });

  it('creates a component alias node when QML name differs from C++ class name', () => {
    const { nodes } = qtResolver.extract!('src/register.cpp', SRC_DIFF_NAME);
    const alias = nodes.find((n) => n.kind === 'component' && n.name === 'Counter');
    expect(alias).toBeDefined();
    expect(alias!.signature).toContain('InternalCounter');
  });

  it('emits a references edge to the C++ class being registered', () => {
    const { references } = qtResolver.extract!('src/register.cpp', SRC_DIFF_NAME);
    const ref = references.find((r) => r.referenceName === 'InternalCounter');
    expect(ref).toBeDefined();
  });

    it.each([
        ['qmlRegisterType', 'demo::NativeWidget', 'Widget'],
        ['qmlRegisterSingletonType', 'demo::AppRegistry', 'Registry'],
        ['qmlRegisterUncreatableType', 'demo::ReadOnlyModel', 'Model'],
    ])('extracts %s registrations with namespaced C++ types', (registration, cppType, qmlName) => {
        const extraArgument = registration === 'qmlRegisterUncreatableType' ? ', "read only"' : '';
        const src = `
#include <QtQml>
void registerTypes() {
    ${registration}<${cppType}>("demo.ui", 1, 0, "${qmlName}"${extraArgument});
}
`.trim();
        const { nodes, references } = qtResolver.extract!('src/register.cpp', src);

        expect(nodes).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'component', name: qmlName }),
        ]));
        expect(references).toEqual(expect.arrayContaining([
            expect.objectContaining({ referenceName: cppType, referenceKind: 'references' }),
        ]));
    });
});

// ---------------------------------------------------------------------------
// qtResolver — Q_INVOKABLE method extraction
// ---------------------------------------------------------------------------

describe('qtResolver — Q_INVOKABLE method extraction', () => {
  const QT_CPP = `
#include <QObject>
class Calculator : public QObject {
    Q_OBJECT
public:
    explicit Calculator(QObject *parent = nullptr);
    Q_INVOKABLE double add(double a, double b);
    Q_INVOKABLE QString formatResult(double value) const;
    int notInvokable() const;
signals:
    void resultReady(double result);
};
`.trim();

  it('extracts Q_INVOKABLE methods as method nodes tagged invokable', () => {
    const { nodes } = qtResolver.extract!('src/calculator.h', QT_CPP);
    const invokable = nodes.filter((n) => n.signature?.startsWith('invokable'));
    expect(invokable.length).toBeGreaterThanOrEqual(2);
    expect(invokable.some((n) => n.name === 'add')).toBe(true);
    expect(invokable.some((n) => n.name === 'formatResult')).toBe(true);
  });

  it('does not tag non-Q_INVOKABLE methods as invokable', () => {
    const { nodes } = qtResolver.extract!('src/calculator.h', QT_CPP);
    const invokable = nodes.filter((n) => n.signature?.startsWith('invokable'));
    expect(invokable.some((n) => n.name === 'notInvokable')).toBe(false);
  });

    it('extracts a Q_INVOKABLE declaration whose parameters span lines', () => {
        const src = `
#include <QObject>
class ReportBridge : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refreshReport(const QString& inputPath,
                                   const QString& outputPath,
                                   bool strictMode);
};
`.trim();
        const { nodes } = qtResolver.extract!('src/report-bridge.h', src);
        const method = nodes.find((node) => node.name === 'refreshReport');
        expect(method).toMatchObject({
            kind: 'method',
            qualifiedName: 'ReportBridge::refreshReport',
            signature: expect.stringMatching(/^invokable refreshReport\(/),
            startLine: 5,
            endLine: 7,
        });
    });
});

// ---------------------------------------------------------------------------
// blankQtMacros — Qt 6 QML macros
// ---------------------------------------------------------------------------

describe('blankQtMacros — Qt 6 QML macros', () => {
  it('blanks QML_ELEMENT to same-length spaces', () => {
    const src = 'class Foo : public QObject {\n    Q_OBJECT\n    QML_ELEMENT\n};\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('QML_ELEMENT');
    expect(result.length).toBe(src.length);
  });

  it('blanks QML_NAMED_ELEMENT(Name) including parentheses', () => {
    const src = 'class Counter : public QObject {\n    Q_OBJECT\n    QML_NAMED_ELEMENT(Counter)\n};\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('QML_NAMED_ELEMENT');
    expect(result.length).toBe(src.length);
  });

  it('blanks QML_SINGLETON', () => {
    const src = 'class App : public QObject {\n    Q_OBJECT\n    QML_SINGLETON\n};\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('QML_SINGLETON');
    expect(result.length).toBe(src.length);
  });

  it('blanks QML_UNCREATABLE("reason") including parentheses', () => {
    const src = '    QML_UNCREATABLE("Cannot create abstract type")\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('QML_UNCREATABLE');
    expect(result.length).toBe(src.length);
  });

  it('blanks QML_VALUE_TYPE(name) including parentheses', () => {
    const src = '    QML_VALUE_TYPE(point)\n';
    const result = blankQtMacros(src);
    expect(result).not.toContain('QML_VALUE_TYPE');
    expect(result.length).toBe(src.length);
  });

    it.each(['\n', '\r\n'])('preserves multiline QML_NAMED_ELEMENT coordinates with %j', async (newline) => {
        const src = ['class Counter {', '  QML_NAMED_ELEMENT(', '    Counter', '  )', 'public:', '  void refresh() {}', '};', ''].join(newline);
        const result = blankQtMacros(src);
        expect(result).not.toContain('QML_NAMED_ELEMENT');
        expect(result.length).toBe(src.length);
        expect(Buffer.byteLength(result)).toBe(Buffer.byteLength(src));
        expect([...result.matchAll(/[\r\n]/g)].map((match) => match.index))
            .toEqual([...src.matchAll(/[\r\n]/g)].map((match) => match.index));
        const { cppPreParse } = await import('../src/extraction/languages/c-cpp');
        expect(cppPreParse(src)).toBe(result);
        const { getParser } = await import('../src/extraction/grammars');
        await loadGrammarsForLanguages(['cpp']);
        const tree = getParser('cpp')!.parse(result)!;
        try {
            expect(tree.rootNode.hasError).toBe(false);
            const method = tree.rootNode.descendantsOfType('function_definition')[0]!;
            expect(method.startIndex).toBe(src.indexOf('void refresh'));
            expect(method.startPosition).toEqual({ row: 5, column: 2 });
        } finally {
            tree.delete();
        }
    });

    it.each([
        'QML_UNCREATABLE(reason("text ) (", nested(1)))',
        'QML_UNCREATABLE(R"TAG(\") unbalanced ()TAG")',
        "QML_UNCREATABLE(reason(1'000, '\\''))",
        'QML_UNCREATABLE(reason(/* ) */ value))',
    ])('balances arguments in %s', (macro) => {
        const tail = '\nvoid refresh() {}\n';
        expect(blankQtMacros(macro + tail)).toBe(' '.repeat(macro.length) + tail);
    });

    it.each([
        'QML_UNCREATABLE("\u00e9 \u6c49 \u{1f680}")',
        'QML_NAMED_ELEMENT(\u6c49)',
        'QML_NAMED_ELEMENT(\u6c49\r\n)',
    ])('preserves Unicode argument bytes and following method coordinates in %s', async (macro) => {
        const src = `class Counter {\r\n  ${macro}\r\npublic:\r\n  void refresh() {}\r\n};\r\n`;
        const result = blankQtMacros(src);
        if (macro.startsWith('QML_UNCREATABLE')) expect(result).not.toContain('QML_');
        else expect(result).toBe(src);
        expect(result).toContain('\u6c49');
        expect(result.length).toBe(src.length);
        expect(Buffer.byteLength(result)).toBe(Buffer.byteLength(src));
        const start = src.indexOf('void refresh');
        expect(Buffer.byteLength(result.slice(0, start))).toBe(Buffer.byteLength(src.slice(0, start)));
        const { cppPreParse } = await import('../src/extraction/languages/c-cpp');
        expect(cppPreParse(src)).toBe(result);
        expect([...result.matchAll(/[\r\n]/g)].map((match) => match.index))
            .toEqual([...src.matchAll(/[\r\n]/g)].map((match) => match.index));
        const { getParser } = await import('../src/extraction/grammars');
        await loadGrammarsForLanguages(['cpp']);
        const tree = getParser('cpp')!.parse(result)!;
        try {
            const method = tree.rootNode.descendantsOfType('function_definition')[0]!;
            expect(method.startIndex).toBe(start);
            expect(method.startPosition).toEqual({ row: 3 + (macro.includes('\n') ? 1 : 0), column: 2 });
        } finally {
            tree.delete();
        }
    });
});

describe('QML JavaScript receivers that are not objects of the project', () => {
  const extractRefs = (body: string) =>
    new QmlExtractor('ui/Main.qml', `import QtQuick 2.15\nItem {\n  id: root\n  function run(items) {\n${body}\n  }\n}\n`)
      .extract().unresolvedReferences;

  it('does not treat JavaScript and QML globals as context objects', () => {
    const refs = extractRefs('    Math.max(1, 2)\n    Qt.quit()\n    console.log("x")\n    JSON.parse("{}")');
    expect(refs.filter((ref) => ref.candidates?.some((candidate) => candidate.startsWith('qt.context-property')))).toEqual([]);
    expect(refs.filter((ref) => ref.candidates?.some((candidate) => candidate.startsWith('qt.enum-member')))).toEqual([]);
  });

  it('keeps an unknown receiver as a context-object candidate', () => {
    const refs = extractRefs('    backend.refresh()');
    expect(refs).toContainEqual(expect.objectContaining({
      referenceName: 'backend.refresh', candidates: ['qt.context-property|backend|refresh'],
    }));
  });

  it('recognises for-of variables, catch parameters and arrow parameters as locals', () => {
    const refs = extractRefs([
      '    for (const entry of items) { entry.open() }',
      '    for (var key in items) { key.trim() }',
      '    try { run() } catch (err) { err.report() }',
      '    items.forEach((item) => item.close())',
      '    items.forEach(item => item.dispose())',
    ].join('\n'));
    const contextRefs = refs.filter((ref) => ref.candidates?.some((candidate) => candidate.startsWith('qt.context-property')));
    expect(contextRefs.map((ref) => ref.referenceName)).toEqual([]);
  });
});

describe('QML id written on the opening line of an object', () => {
  it('registers the id of a one-line object so calls on it resolve as id calls', () => {
    const src = `import QtQuick 2.15
Item {
  id: root
  Panel { id: panel; width: 10 }
  Panel {
    id: other
  }
  function run() {
    panel.refresh()
    other.refresh()
  }
}`;
    const refs = new QmlExtractor('ui/Main.qml', src).extract().unresolvedReferences;
    expect(refs).toContainEqual(expect.objectContaining({
      referenceName: 'panel.refresh', candidates: ['qt.qml-id|panel|Panel|refresh'],
    }));
    expect(refs).toContainEqual(expect.objectContaining({
      referenceName: 'other.refresh', candidates: ['qt.qml-id|other|Panel|refresh'],
    }));
  });

  it('does not take an id from a nested object on the same line', () => {
    const src = `import QtQuick 2.15
Item {
  Row { Text { id: inner } }
  function run() { inner.show() }
}`;
    const refs = new QmlExtractor('ui/Main.qml', src).extract().unresolvedReferences;
    expect(refs.find((ref) => ref.referenceName === 'inner.show')?.candidates)
      .not.toContain('qt.qml-id|inner|Row|show');
  });
});
