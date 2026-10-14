import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
    await initGrammars();
});

describe('QML persisted signal resolution', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('resolves handlers by owner and leaves unknown owners unresolved', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-resolution-'));
    fs.writeFileSync(
      path.join(tempDir, 'AlphaButton.qml'),
      'import QtQuick\nItem {\n    signal clicked()\n}\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'BetaButton.qml'),
      'import QtQuick\nItem {\n    signal clicked()\n}\n',
    );
    fs.writeFileSync(
        path.join(tempDir, 'AttachedWidget.qml'),
        'import QtQuick\nItem {\n    signal activated()\n}\n',
    );
      fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import QtQuick
Item {
    signal ready()
    onReady: {}

    AlphaButton {
        onClicked: {}
    }
    BetaButton {
        onClicked: {}
    }
    AttachedWidget.onActivated: {}
    MainBarButton {
        onClicked: {}
    }

    Component.onCompleted: {
        finishStartup()
    }
    function finishStartup() {}
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      const result = await graph.indexAll();
      expect(result.success).toBe(true);
      expect(graph.getDetectedFrameworks()).toContain('qt');

      const alphaSignal = graph.getNodesInFile('AlphaButton.qml').find(
        (node) => node.kind === 'method' && node.name === 'clicked',
      );
      const betaSignal = graph.getNodesInFile('BetaButton.qml').find(
        (node) => node.kind === 'method' && node.name === 'clicked',
      );
        const activatedSignal = graph.getNodesInFile('AttachedWidget.qml').find(
            (node) => node.kind === 'method' && node.name === 'activated',
        );
      const mainNodes = graph.getNodesInFile('Main.qml');
      const readySignal = mainNodes.find((node) => node.kind === 'method' && node.name === 'ready');
      const readyHandler = mainNodes.find((node) => node.kind === 'method' && node.name === 'onReady');
      const finishStartup = mainNodes.find(
        (node) => node.kind === 'function' && node.name === 'finishStartup',
      );
      const completedHandler = mainNodes.find(
        (node) => node.kind === 'method' && node.name === 'Component.onCompleted',
      );
        const attachedHandler = mainNodes.find(
            (node) => node.kind === 'method' && node.name === 'AttachedWidget.onActivated',
        );
      const clickHandlers = mainNodes
        .filter((node) => node.kind === 'method' && node.name === 'onClicked')
        .sort((left, right) => left.startLine - right.startLine);

      expect(alphaSignal).toBeDefined();
      expect(betaSignal).toBeDefined();
        expect(activatedSignal).toBeDefined();
      expect(readySignal).toBeDefined();
      expect(readyHandler).toBeDefined();
      expect(finishStartup).toBeDefined();
      expect(completedHandler).toBeDefined();
        expect(attachedHandler).toBeDefined();
      expect(clickHandlers).toHaveLength(3);

      const callTargets = (nodeId: string) =>
        graph.getOutgoingEdges(nodeId)
          .filter((edge) => edge.kind === 'calls')
          .map((edge) => edge.target);
      const callEdges = (nodeId: string) =>
        graph.getOutgoingEdges(nodeId).filter((edge) => edge.kind === 'calls');
        const referenceTargets = (nodeId: string) =>
            graph.getOutgoingEdges(nodeId)
                .filter((edge) => edge.kind === 'references')
                .map((edge) => edge.target);
        const referenceEdges = (nodeId: string) =>
            graph.getOutgoingEdges(nodeId).filter((edge) => edge.kind === 'references');
        const qualifiedReferenceTargets = (nodeId: string) => {
            const targetIds = new Set(referenceTargets(nodeId));
        return [
          ...graph.getNodesInFile('AlphaButton.qml'),
          ...graph.getNodesInFile('BetaButton.qml'),
          ...mainNodes,
        ]
          .filter((node) => targetIds.has(node.id))
          .map((node) => node.qualifiedName);
      };
        const synthesized = (sourceId: string, targetId: string) =>
            graph.getOutgoingEdges(sourceId).find(
                (edge) =>
                    edge.kind === 'calls' &&
                    edge.target === targetId &&
                    edge.provenance === 'heuristic' &&
                    edge.metadata?.synthesizedBy === 'qt-signal-channel',
            );

        expect(callTargets(readyHandler!.id)).not.toContain(readySignal!.id);
        expect(referenceTargets(readyHandler!.id)).toEqual([readySignal!.id]);
        expect(qualifiedReferenceTargets(clickHandlers[0]!.id)).toEqual(['AlphaButton.qml::clicked']);
        expect(qualifiedReferenceTargets(clickHandlers[1]!.id)).toEqual(['BetaButton.qml::clicked']);
        expect(qualifiedReferenceTargets(clickHandlers[2]!.id)).toEqual([]);
        expect(callTargets(clickHandlers[0]!.id)).not.toContain(alphaSignal!.id);
        expect(callTargets(clickHandlers[1]!.id)).not.toContain(betaSignal!.id);
        expect(referenceEdges(clickHandlers[0]!.id)[0]?.metadata).toMatchObject({ resolvedBy: 'framework' });
        expect(referenceEdges(clickHandlers[1]!.id)[0]?.metadata).toMatchObject({ resolvedBy: 'framework' });
        expect(synthesized(readySignal!.id, readyHandler!.id)).toMatchObject({
            metadata: expect.objectContaining({ registeredAt: 'Main.qml:4' }),
        });
        expect(synthesized(alphaSignal!.id, clickHandlers[0]!.id)).toBeDefined();
        expect(synthesized(betaSignal!.id, clickHandlers[1]!.id)).toBeDefined();
        expect(callTargets(attachedHandler!.id)).not.toContain(activatedSignal!.id);
        expect(referenceTargets(attachedHandler!.id)).toContain(activatedSignal!.id);
        expect(synthesized(activatedSignal!.id, attachedHandler!.id)).toBeDefined();
      expect(callTargets(completedHandler!.id)).toContain(finishStartup!.id);
      expect(graph.getOutgoingEdges(completedHandler!.id)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'references' })]),
      );
    } finally {
      graph.close();
    }
  });

  it('resolves calls through a QML id only to the exact C++ owner', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-id-resolution-'));
    fs.writeFileSync(
      path.join(tempDir, 'native-panel.h'),
      `#include <QObject>
class NativePanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'other-panel.h'),
      `#include <QObject>
class OtherPanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import Demo.Ui
Item {
    NativePanel {
        id: backend
    }
    function refreshPanel() {
        backend.refresh()
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      const result = await graph.indexAll();
      expect(result.success).toBe(true);

      const caller = graph.getNodesInFile('Main.qml').find(
        (node) => node.kind === 'function' && node.name === 'refreshPanel',
      );
      const nativeMethod = graph.getNodesInFile('native-panel.h').find(
        (node) => node.kind === 'method' && node.name === 'refresh',
      );
      const otherMethod = graph.getNodesInFile('other-panel.h').find(
        (node) => node.kind === 'method' && node.name === 'refresh',
      );

      expect(caller).toBeDefined();
      expect(nativeMethod).toBeDefined();
      expect(otherMethod).toBeDefined();
      const callTargets = graph.getOutgoingEdges(caller!.id)
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => edge.target);
      expect(callTargets).toEqual([nativeMethod!.id]);
      expect(callTargets).not.toContain(otherMethod!.id);
    } finally {
      graph.close();
    }
  });

    it.each([
        ['int value', 'QString value', false],
        ['int value', 'int value, bool enabled', false],
        ['int value = 0', 'int renamed', true],
        ['const QString& value = QString(QString())', 'const QString& renamed', true],
        ['const QStringList& values = QStringList(QString(), QString())', 'const QStringList& renamed', true],
        ['const QString& value = QString()', 'int renamed', false],
        ['QList<int> values = QList<int>()', 'QList<int> renamed', false],
        ['void (*callback)()', 'void (*callback)()', false],
    ])('checks invokable parameter types before using a sole body: %s / %s', async (declaredParameters, implementedParameters, matches) => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-invokable-parameters-'));
        fs.writeFileSync(path.join(tempDir, 'backend.h'), `#include <QObject>
class Backend : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh(${declaredParameters});
};
`);
        fs.writeFileSync(path.join(tempDir, 'backend.cpp'), `#include "backend.h"
void Backend::refresh(${implementedParameters}) {}
`);
        fs.writeFileSync(path.join(tempDir, 'Main.qml'), `import QtQuick
Item {
    Backend {
      id: backend
    }
    function run() { backend.refresh(1) }
}
`);
        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const caller = graph.getNodesInFile('Main.qml').find((node) => node.name === 'run');
            const declaration = graph.getNodesInFile('backend.h').find((node) => node.signature?.startsWith('invokable '));
            const implementation = graph.getNodesInFile('backend.cpp').find((node) => node.qualifiedName === 'Backend::refresh');
            expect(caller).toBeDefined();
            expect(declaration).toBeDefined();
            expect(implementation).toBeDefined();
            const targets = graph.getOutgoingEdges(caller!.id).filter((edge) => edge.kind === 'calls').map((edge) => edge.target);
            expect(targets).toEqual([matches ? implementation!.id : declaration!.id]);
        } finally {
            graph.close();
        }
    });

    it('persists id shadowing exclusions and resolves unshadowed and root id calls', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-id-shadowing-'));
        fs.writeFileSync(path.join(tempDir, 'backend.h'), `#include <QObject>
class Backend : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`);
        fs.writeFileSync(path.join(tempDir, 'Main.qml'), `import QtQuick
Item {
    id: root
    Backend {
      id: backend
    }
    function refresh() {}
    function run(backend) { backend.refresh() }
    function runLocal() {
        const backend = {}
        backend.refresh()
    }
    function runUnshadowed() { backend.refresh() }
    function runRoot() { root.refresh() }
}
`);
        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const qmlNodes = graph.getNodesInFile('Main.qml');
            const nativeRefresh = graph.getNodesInFile('backend.h').find((node) => node.signature?.startsWith('invokable '));
            const rootRefresh = qmlNodes.find((node) => node.name === 'refresh');
            expect(nativeRefresh).toBeDefined();
            expect(rootRefresh).toBeDefined();
            const targets = (name: string) => {
                const caller = qmlNodes.find((node) => node.name === name);
                expect(caller).toBeDefined();
                return graph.getOutgoingEdges(caller!.id).filter((edge) => edge.kind === 'calls').map((edge) => edge.target);
            };
            expect.soft(targets('run')).toEqual([]);
            expect.soft(targets('runLocal')).toEqual([]);
            expect.soft(targets('runUnshadowed')).toEqual([nativeRefresh!.id]);
            expect.soft(targets('runRoot')).toEqual([rootRefresh!.id]);
        } finally {
            graph.close();
        }
    });

    it('does not resolve an unknown context signal to an unrelated sole signal', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-context-signal-fallback-'));
        fs.writeFileSync(path.join(tempDir, 'backend.h'), `#include <QObject>
class Backend : public QObject {
    Q_OBJECT
signals:
    void updated();
};
`);
        fs.writeFileSync(path.join(tempDir, 'Main.qml'), `import QtQuick
Item {
    Connections {
        target: unknownService
        function onUpdated() {}
    }
}
`);
        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const handler = graph.getNodesInFile('Main.qml').find((node) => node.name === 'onUpdated');
            expect(handler).toBeDefined();
            expect(graph.getOutgoingEdges(handler!.id).filter((edge) => edge.kind === 'calls' || edge.kind === 'references')).toEqual([]);
        } finally {
            graph.close();
        }
    });

  it('persists a typed id call from a multi-call attached handler body', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-handler-id-'));
    fs.writeFileSync(
      path.join(tempDir, 'native-panel.h'),
      `#include <QObject>
class NativePanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh(const QString& inputPath,
                             bool strictMode);
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import QtQuick
Item {
    NativePanel {
        id: backend
    }
    Component.onCompleted: {
        console.log("starting")
        backend.refresh("input", true)
        console.log("done")
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const handler = graph.getNodesInFile('Main.qml').find(
        (node) => node.name === 'Component.onCompleted',
      );
      const target = graph.getNodesInFile('native-panel.h').find(
        (node) => node.name === 'refresh' && node.signature?.startsWith('invokable'),
      );
      expect(handler).toBeDefined();
      expect(target).toBeDefined();
      expect(graph.getOutgoingEdges(handler!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'calls', target: target!.id }),
      ]));
    } finally {
      graph.close();
    }
  });

    it('resolves block-style and inline QML handlers to an invokable C++ method', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-click-handler-'));
        fs.writeFileSync(
            path.join(tempDir, 'native-panel.h'),
            `#include <QObject>
class NativePanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'Main.qml'),
            `import QtQuick
Item {
    NativePanel {
        id: backend
    }
    MouseArea {
        onClicked: {
            backend.refresh()
        }
    }
    MouseArea {
      onPressed: backend.refresh()
    }
}
`,
        );

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const handler = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'method' && node.name === 'onClicked',
            );
            const inlineHandler = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'method' && node.name === 'onPressed',
            );
            const target = graph.getNodesInFile('native-panel.h').find(
                (node) => node.kind === 'method' && node.name === 'refresh',
            );

            expect(handler).toBeDefined();
            expect(inlineHandler).toBeDefined();
            expect(target).toBeDefined();
            expect(graph.getOutgoingEdges(handler!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: target!.id }),
            ]));
            expect(graph.getOutgoingEdges(inlineHandler!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: target!.id }),
            ]));
        } finally {
            graph.close();
        }
    });

  it('resolves calls through a QML id to the exact QML component file', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-component-id-'));
    fs.writeFileSync(
      path.join(tempDir, 'ChildPanel.qml'),
      'import QtQuick\nItem {\n    function reload() {}\n}\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'OtherPanel.qml'),
      'import QtQuick\nItem {\n    function reload() {}\n}\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import QtQuick
Item {
  ChildPanel {
    id: child
  }
    function reloadChild() {
        child.reload()
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesInFile('Main.qml').find((node) => node.name === 'reloadChild');
      const childMethod = graph.getNodesInFile('ChildPanel.qml').find((node) => node.name === 'reload');
      const otherMethod = graph.getNodesInFile('OtherPanel.qml').find((node) => node.name === 'reload');
      const targets = graph.getOutgoingEdges(caller!.id)
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => edge.target);
      expect(targets).toEqual([childMethod!.id]);
      expect(targets).not.toContain(otherMethod!.id);
    } finally {
      graph.close();
    }
  });

  it('resolves a QML id through its registered QML type alias', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-registered-id-'));
    fs.writeFileSync(
      path.join(tempDir, 'internal-panel.h'),
      `#include <QObject>
class InternalPanel : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'registration.cpp'),
      `#include <QtQml>
#include "internal-panel.h"
void registerTypes() {
    qmlRegisterType<InternalPanel>("Demo.Ui", 1, 0, "FriendlyPanel");
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import Demo.Ui
Item {
  FriendlyPanel {
    id: panel
  }
    function updatePanel() {
        panel.refresh()
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesInFile('Main.qml').find((node) => node.name === 'updatePanel');
      const method = graph.getNodesInFile('internal-panel.h').find((node) => node.name === 'refresh');
      const targets = graph.getOutgoingEdges(caller!.id)
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => edge.target);
      expect(targets).toEqual([method!.id]);
    } finally {
      graph.close();
    }
  });

    it('prefers a same-name registered C++ type over a local QML component', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-same-name-registration-'));
        fs.writeFileSync(
            path.join(tempDir, 'file-analyzer.h'),
            `#include <QObject>
class FileAnalyzer : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'registration.cpp'),
            `#include <QtQml>
void registerTypes() {
    qmlRegisterType<FileAnalyzer>("Demo.Ui", 1, 0, "FileAnalyzer");
}
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'FileAnalyzer.qml'),
            'import QtQuick\nItem {\n    function refresh() {}\n}\n',
        );
        fs.writeFileSync(
            path.join(tempDir, 'Main.qml'),
            `import Demo.Ui
Item {
    FileAnalyzer {
        id: analyzer
    }
    function update() {
        analyzer.refresh()
    }
}
`,
        );

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const mainRoot = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'component' && node.name === 'Main',
            );
            const cppClass = graph.getNodesInFile('file-analyzer.h').find(
                (node) => node.kind === 'class' && node.name === 'FileAnalyzer',
            );
            const qmlComponent = graph.getNodesInFile('FileAnalyzer.qml').find(
                (node) => node.kind === 'component' && node.name === 'FileAnalyzer',
            );
            const caller = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'function' && node.name === 'update',
            );
            const cppMethod = graph.getNodesInFile('file-analyzer.h').find(
                (node) => node.kind === 'method' && node.name === 'refresh',
            );
            const qmlMethod = graph.getNodesInFile('FileAnalyzer.qml').find(
                (node) => node.kind === 'function' && node.name === 'refresh',
            );

            expect(mainRoot).toBeDefined();
            expect(cppClass).toBeDefined();
            expect(qmlComponent).toBeDefined();
            expect(caller).toBeDefined();
            expect(cppMethod).toBeDefined();
            expect(qmlMethod).toBeDefined();
            expect(graph.getOutgoingEdges(mainRoot!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'references', target: cppClass!.id }),
            ]));
            expect(graph.getOutgoingEdges(mainRoot!.id)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'references', target: qmlComponent!.id }),
            ]));
            expect(graph.getOutgoingEdges(caller!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: cppMethod!.id }),
            ]));
            expect(graph.getOutgoingEdges(caller!.id)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: qmlMethod!.id }),
            ]));
        } finally {
            graph.close();
        }
    });

  it('resolves a registered QML signal handler through its type alias', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-signal-alias-'));
    fs.writeFileSync(
      path.join(tempDir, 'internal-panel.h'),
      `#include <QObject>
class InternalPanel : public QObject {
    Q_OBJECT
signals:
    void updated();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'registration.cpp'),
      `#include <QtQml>
void registerTypes() {
    qmlRegisterType<InternalPanel>("Demo.Ui", 1, 0, "FriendlyPanel");
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      'import Demo.Ui\nItem {\n    FriendlyPanel {\n        onUpdated: {}\n    }\n}\n',
    );
    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const handler = graph.getNodesInFile('Main.qml').find((node) => node.name === 'onUpdated');
      const signal = graph.getNodesInFile('internal-panel.h').find((node) => node.name === 'updated');
      expect(graph.getOutgoingEdges(handler!.id)).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'references', target: signal!.id }),
      ]));
        expect(graph.getOutgoingEdges(handler!.id)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'calls', target: signal!.id }),
      ]));
          expect(graph.getOutgoingEdges(signal!.id)).toEqual(expect.arrayContaining([
              expect.objectContaining({
                  kind: 'calls',
                  target: handler!.id,
                  provenance: 'heuristic',
                  metadata: expect.objectContaining({
                      synthesizedBy: 'qt-signal-channel',
                      registeredAt: 'Main.qml:4',
                  }),
              }),
          ]));
      } finally {
          graph.close();
      }
  });

    it('resolves a Connections handler only to its literal target type and extracts its body once', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-connections-target-'));
        fs.writeFileSync(
            path.join(tempDir, 'native-panel.h'),
            `#include <QObject>
class NativePanel : public QObject {
    Q_OBJECT
signals:
    void updated();
public:
    Q_INVOKABLE void refresh();
};
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'other-panel.h'),
            `#include <QObject>
class OtherPanel : public QObject {
    Q_OBJECT
signals:
    void updated();
};
`,
        );
        fs.writeFileSync(
            path.join(tempDir, 'Main.qml'),
            `import QtQuick
Item {
    NativePanel {
        id: backend
    }
    Connections {
        target: backend
        function onUpdated() {
            backend.refresh()
        }
    }
}
`,
        );

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const mainNodes = graph.getNodesInFile('Main.qml');
            const connections = mainNodes.find((node) => node.kind === 'component' && node.name === 'Connections');
            const handler = mainNodes.find((node) => node.kind === 'method' && node.name === 'onUpdated');
            const nativeSignal = graph.getNodesInFile('native-panel.h').find((node) => node.name === 'updated');
            const otherSignal = graph.getNodesInFile('other-panel.h').find((node) => node.name === 'updated');
            const refresh = graph.getNodesInFile('native-panel.h').find((node) => node.name === 'refresh');

            expect(connections).toBeDefined();
            expect(handler).toMatchObject({ signature: 'handler onUpdated' });
            expect(nativeSignal).toBeDefined();
            expect(otherSignal).toBeDefined();
            expect(refresh).toBeDefined();
            expect(graph.getOutgoingEdges(connections!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'contains', target: handler!.id }),
            ]));

            const calls = graph.getOutgoingEdges(handler!.id).filter((edge) => edge.kind === 'calls');
            expect(calls).toEqual(expect.arrayContaining([
                expect.objectContaining({ target: refresh!.id }),
            ]));
            expect(calls).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ target: nativeSignal!.id }),
                expect.objectContaining({ target: otherSignal!.id }),
            ]));
            expect(graph.getOutgoingEdges(handler!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'references', target: nativeSignal!.id }),
            ]));
            expect(graph.getOutgoingEdges(handler!.id)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'references', target: otherSignal!.id }),
            ]));
            expect(graph.getOutgoingEdges(nativeSignal!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: 'calls',
                    target: handler!.id,
                    provenance: 'heuristic',
                    metadata: expect.objectContaining({
                        synthesizedBy: 'qt-signal-channel',
                        registeredAt: 'Main.qml:8',
                    }),
                }),
            ]));
            expect(calls.filter((edge) => edge.target === refresh!.id)).toHaveLength(1);
        } finally {
            graph.close();
        }
    });

    it('does not guess a Connections signal owner for a dynamic target expression', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-connections-dynamic-target-'));
        fs.writeFileSync(
            path.join(tempDir, 'native-panel.h'),
            '#include <QObject>\nclass NativePanel : public QObject {\n    Q_OBJECT\nsignals:\n    void updated();\n};\n',
        );
        fs.writeFileSync(
            path.join(tempDir, 'other-panel.h'),
            '#include <QObject>\nclass OtherPanel : public QObject {\n    Q_OBJECT\nsignals:\n    void updated();\n};\n',
        );
        fs.writeFileSync(
            path.join(tempDir, 'Main.qml'),
            `import QtQuick
Item {
    NativePanel { id: backend }
    Connections {
        target: selectTarget()
        function onUpdated() {}
    }
    function selectTarget() { return backend }
}
`,
        );

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const handler = graph.getNodesInFile('Main.qml').find(
                (node) => node.kind === 'method' && node.name === 'onUpdated',
            );
            const signalIds = new Set(
                [...graph.getNodesInFile('native-panel.h'), ...graph.getNodesInFile('other-panel.h')]
                    .filter((node) => node.kind === 'method' && node.name === 'updated')
                    .map((node) => node.id),
            );

            expect(handler).toBeDefined();
            expect(graph.getOutgoingEdges(handler!.id)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: expect.any(String) }),
            ]));
            expect(graph.getOutgoingEdges(handler!.id).some(
                (edge) => edge.kind === 'calls' && signalIds.has(edge.target),
            )).toBe(false);
            expect(graph.getOutgoingEdges(handler!.id).some(
                (edge) => edge.kind === 'references' && signalIds.has(edge.target),
            )).toBe(false);
    } finally {
      graph.close();
    }
  });

  it('resolves a QML singleton alias call to its registered C++ type', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-singleton-alias-'));
    fs.writeFileSync(
      path.join(tempDir, 'app-registry.h'),
      '#include <QObject>\nclass AppRegistry : public QObject {\n Q_OBJECT\npublic:\n Q_INVOKABLE void refresh();\n};\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'registration.cpp'),
      '#include <QtQml>\nvoid registerTypes() { qmlRegisterSingletonType<AppRegistry>("Demo.Ui", 1, 0, "Registry"); }\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      'import Demo.Ui\nItem {\n function update() { Registry.refresh() }\n}\n',
    );
    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const caller = graph.getNodesInFile('Main.qml').find((node) => node.name === 'update');
      const target = graph.getNodesInFile('app-registry.h').find((node) => node.name === 'refresh');
      expect(graph.getOutgoingEdges(caller!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'calls', target: target!.id }),
      ]));
    } finally {
      graph.close();
    }
  });

  it('resolves a qualified enum member to its exact owner', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-enum-owner-'));
    fs.writeFileSync(
      path.join(tempDir, 'qt-enums.cpp'),
      `#include <QObject>
namespace Qt {
enum class Orientation {
  Horizontal,
  Vertical,
};
}
namespace Other {
enum class Orientation {
  Vertical,
};
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      'import QtQuick\nItem {\n    property int orientation: Qt.Vertical\n}\n',
    );
    const graph = CodeGraph.initSync(tempDir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const source = graph.getNodesInFile('Main.qml').find((node) => node.name === 'orientation');
      const target = graph.getNodesInFile('qt-enums.cpp').find(
        (node) => node.name === 'Vertical' && node.qualifiedName.startsWith('Qt::'),
      );
      expect(target).toBeDefined();
      expect(graph.getOutgoingEdges(source!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'references', target: target!.id }),
      ]));
    } finally {
      graph.close();
    }
  });

  describe('enum members reached through a QML type name', () => {
    const indexProject = async (files: Record<string, string>) => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-enum-alias-'));
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(tempDir, name), content);
      const graph = CodeGraph.initSync(tempDir);
      expect((await graph.indexAll()).success).toBe(true);
      const referencesFrom = (file: string, name: string) => {
        const source = graph.getNodesInFile(file).find((node) => node.name === name)!;
        return graph.getOutgoingEdges(source.id).filter((edge) => edge.kind === 'references');
      };
      return { graph, referencesFrom };
    };

    const vrfHeader = `#include <QObject>
namespace vrf {
class VRF : public QObject {
  Q_OBJECT
public:
  enum AppMode { DRC, LVS };
  enum { NoZoom = 1 };
  enum Roles { TypeNameRole = 256 };
};
}
`;
    const registration = `#include <QtQml>
void registerTypes() {
  qmlRegisterType<vrf::VRF>("Demo.Ui", 1, 0, "VRF");
  qmlRegisterType<vrf::VRF>("Demo.Ui", 1, 0, "VrfObj");
  qmlRegisterType<vrf::VRF>("Demo.Ui", 1, 0, "VRFTreeModel");
}
`;

    it('resolves Alias.Enum.Member, Alias.Member and anonymous-enum members to the registered C++ class', async () => {
      const { graph, referencesFrom } = await indexProject({
        'vrf.h': vrfHeader,
        'registration.cpp': registration,
        'Main.qml': `import Demo.Ui
Item {
  property int mode: VRF.AppMode.DRC
  property int zoom: VrfObj.NoZoom
  property int role: VRFTreeModel.TypeNameRole
}
`,
      });
      try {
        const member = (name: string) => graph.getNodesInFile('vrf.h').find((node) => node.kind === 'enum_member' && node.name === name)!;
        expect(referencesFrom('Main.qml', 'mode').map((edge) => edge.target)).toContain(member('DRC').id);
        expect(referencesFrom('Main.qml', 'zoom').map((edge) => edge.target)).toContain(member('NoZoom').id);
        expect(referencesFrom('Main.qml', 'role').map((edge) => edge.target)).toContain(member('TypeNameRole').id);
      } finally {
        graph.close();
      }
    });

    it('resolves Component.Enum.Member to an enum declared in that component file', async () => {
      const { graph, referencesFrom } = await indexProject({
        'CustomToolTip.qml': `import QtQuick
Item {
  enum ArrowAnchors {
    TopLeft,
    BottomCenter
  }
}
`,
        'Main.qml': `import QtQuick
Item {
  property int anchor: CustomToolTip.ArrowAnchors.BottomCenter
}
`,
      });
      try {
        const target = graph.getNodesInFile('CustomToolTip.qml').find((node) => node.kind === 'enum_member' && node.name === 'BottomCenter')!;
        expect(referencesFrom('Main.qml', 'anchor').map((edge) => edge.target)).toContain(target.id);
      } finally {
        graph.close();
      }
    });

    it('does not guess when the alias names two classes that both have the member', async () => {
      const { graph, referencesFrom } = await indexProject({
        'first.h': '#include <QObject>\nclass First : public QObject {\n  Q_OBJECT\npublic:\n  enum Mode { Fast };\n};\n',
        'second.h': '#include <QObject>\nclass Second : public QObject {\n  Q_OBJECT\npublic:\n  enum Mode { Fast };\n};\n',
        'registration.cpp': '#include <QtQml>\nvoid registerTypes() {\n  qmlRegisterType<First>("Demo.Ui", 1, 0, "Engine");\n  qmlRegisterType<Second>("Demo.Ui", 1, 0, "Engine");\n}\n',
        'Main.qml': 'import Demo.Ui\nItem {\n  property int mode: Engine.Mode.Fast\n}\n',
      });
      try {
        expect(referencesFrom('Main.qml', 'mode')).toEqual([]);
      } finally {
        graph.close();
      }
    });
  });

  describe('Q_PROPERTY accessors', () => {
    const indexProject = async (files: Record<string, string>) => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qt-property-'));
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(tempDir, name), content);
      const graph = CodeGraph.initSync(tempDir);
      expect((await graph.indexAll()).success).toBe(true);
      return graph;
    };

    it('links a property to its getter, setter and notify signal but never to itself', async () => {
      const graph = await indexProject({
        'counter.h': `#include <QObject>
namespace app {
class Counter : public QObject {
  Q_OBJECT
  Q_PROPERTY(int count READ count WRITE setCount NOTIFY countChanged)
public:
  int count() const { return m_count; }
  void setCount(int value) { m_count = value; }
signals:
  void countChanged();
private:
  int m_count = 0;
};
}
`,
      });
      try {
        const property = graph.getNodesInFile('counter.h').find((node) => node.kind === 'property' && node.name === 'count')!;
        const outgoing = graph.getOutgoingEdges(property.id);
        const targets = outgoing.map((edge) => graph.getNode(edge.target)!);
        expect(outgoing.some((edge) => edge.target === property.id)).toBe(false);
        expect(targets.some((node) => node.kind !== 'property' && node.name === 'count')).toBe(true);
        expect(targets.some((node) => node.name === 'setCount')).toBe(true);
        expect(targets.some((node) => node.name === 'countChanged' && node.signature?.startsWith('signal '))).toBe(true);
        expect(targets.some((node) => node.kind === 'property')).toBe(false);
      } finally {
        graph.close();
      }
    });

    it('leaves an accessor unresolved rather than binding it to the property of the same name', async () => {
      const graph = await indexProject({
        'item.h': `#include <QObject>
class Item : public QObject {
  Q_OBJECT
  Q_PROPERTY(int width READ width)
};
`,
      });
      try {
        const property = graph.getNodesInFile('item.h').find((node) => node.kind === 'property' && node.name === 'width')!;
        expect(graph.getOutgoingEdges(property.id)).toEqual([]);
      } finally {
        graph.close();
      }
    });
  });

  describe('QML imports', () => {
    const indexProject = async (files: Record<string, string>) => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-import-'));
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(tempDir, name)), { recursive: true });
        fs.writeFileSync(path.join(tempDir, name), content);
      }
      const graph = CodeGraph.initSync(tempDir);
      expect((await graph.indexAll()).success).toBe(true);
      const importEdges = (file: string) => {
        const imports = graph.getNodesInFile(file).filter((node) => node.kind === 'import');
        return imports.flatMap((node) =>
          graph.getOutgoingEdges(node.id).map((edge) => ({ name: node.name, edge, target: graph.getNode(edge.target)! })));
      };
      return { graph, importEdges };
    };

    it('links a module import to the file that registers types under that URI and ignores Qt modules', async () => {
      const { graph, importEdges } = await indexProject({
        'analyzer.h': '#include <QObject>\nclass FileAnalyzer : public QObject {\n  Q_OBJECT\n};\n',
        'registration.cpp': '#include <QtQml>\n#include "analyzer.h"\nvoid registerTypes() {\n  qmlRegisterType<FileAnalyzer>("FileAnalyzer", 1, 0, "FileAnalyzer");\n}\n',
        'Main.qml': 'import QtQuick 2.15\nimport FileAnalyzer 1.0\nItem {\n}\n',
      });
      try {
        const edges = importEdges('Main.qml');
        expect(edges.map((entry) => entry.name)).toEqual(['FileAnalyzer']);
        expect(edges[0]!.target).toMatchObject({ kind: 'file', filePath: 'registration.cpp' });
      } finally {
        graph.close();
      }
    });

    it('links a quoted script import to its file and leaves a directory import alone', async () => {
      const { graph, importEdges } = await indexProject({
        'util.js': 'function helper() { return 1; }\n',
        'components/Card.qml': 'import QtQuick\nItem {\n}\n',
        'Main.qml': 'import QtQuick\nimport "components"\nimport "util.js" as U\nItem {\n}\n',
      });
      try {
        const edges = importEdges('Main.qml');
        expect(edges).toHaveLength(1);
        expect(edges[0]!.target).toMatchObject({ kind: 'file', filePath: 'util.js' });
      } finally {
        graph.close();
      }
    });

    it('never produces an import-to-import edge or a self edge', async () => {
      const { graph, importEdges } = await indexProject({
        'Main.qml': 'import QtQuick 2.15\nimport QtQuick.Controls 2.15\nimport Backend 1.0\nItem {\n}\n',
        'Other.qml': 'import Backend 1.0\nItem {\n}\n',
      });
      try {
        for (const file of ['Main.qml', 'Other.qml']) {
          for (const { edge, target } of importEdges(file)) {
            expect(target.kind).not.toBe('import');
            expect(target.id).not.toBe(edge.source);
          }
        }
        expect(importEdges('Main.qml')).toEqual([]);
      } finally {
        graph.close();
      }
    });
  });

  it('resolves a context property call only to its registered C++ type', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-context-resolution-'));
    fs.writeFileSync(
      path.join(tempDir, 'report-bridge.h'),
      `#include <QObject>
class ReportBridge : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'other-bridge.h'),
      `#include <QObject>
class OtherBridge : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'bootstrap.cpp'),
      `#include <QQmlContext>
#include "report-bridge.h"
void expose(QQmlContext *context, ReportBridge *service) {
    context->setContextProperty("reportService", service);
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'Main.qml'),
      `import QtQuick
Item {
    function updateReport() {
        reportService.refresh()
    }
}
`,
    );

    const graph = CodeGraph.initSync(tempDir);
    try {
      const result = await graph.indexAll();
      expect(result.success).toBe(true);

      const caller = graph.getNodesInFile('Main.qml').find(
        (node) => node.kind === 'function' && node.name === 'updateReport',
      );
      const reportMethod = graph.getNodesInFile('report-bridge.h').find(
        (node) => node.kind === 'method' && node.name === 'refresh',
      );
      const otherMethod = graph.getNodesInFile('other-bridge.h').find(
        (node) => node.kind === 'method' && node.name === 'refresh',
      );

      expect(caller).toBeDefined();
      expect(reportMethod).toBeDefined();
      expect(otherMethod).toBeDefined();
      const callTargets = graph.getOutgoingEdges(caller!.id)
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => edge.target);
      expect(callTargets).toEqual([reportMethod!.id]);
      expect(callTargets).not.toContain(otherMethod!.id);
    } finally {
      graph.close();
    }
  });

    it('resolves namespaced context and alias calls and both Connections forms to executable bodies', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-context-body-'));
        fs.writeFileSync(path.join(tempDir, 'backend.h'), `#include <QObject>
namespace demo {
class Backend : public QObject {
    Q_OBJECT
    QML_NAMED_ELEMENT(FriendlyBackend)
signals:
    void updated();
public slots:
    void apply();
public:
    Q_INVOKABLE void refresh();
};
}
namespace other {
class Backend : public QObject {
    Q_OBJECT
signals:
    void updated();
public:
    Q_INVOKABLE void refresh();
};
}
`);
        fs.writeFileSync(path.join(tempDir, 'backend.cpp'), `#include <QQmlContext>
#include <QtQml>
#include "backend.h"
void save() {}
void demo::Backend::refresh() { save(); }
void demo::Backend::apply() { save(); }
void other::Backend::refresh() {}
void expose(QQmlContext *context, demo::Backend *vrf) {
    /* other::Backend *vrf; { */
    context->setContextProperty("reportService", QVariant :: fromValue(
        vrf
    ));
    qmlRegisterSingletonType<demo::Backend>("Demo.Ui", 1, 0, "Registry");
}
`);
        fs.writeFileSync(path.join(tempDir, 'Main.qml'), `import QtQuick
Item {
    FriendlyBackend {
        id: backend
        onUpdated: { backend.refresh() }
    }
    function updateReport() { reportService.refresh() }
    function updateAlias() { backend.refresh() }
    function updateRegistry() { Registry.refresh() }
    Connections {
        target: reportService
        function onUpdated() {
            reportService.refresh()
            finish()
        }
    }
    Connections {
        onUpdated: {
            reportService.apply()
            finish()
        }
        target: reportService
    }
    Connections {
        target: Registry
        function onUpdated() { Registry.refresh() }
    }
    Connections {
        target: reportService
        function onRefresh() {}
    }
    function finish() {}
}
`);
        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const headers = graph.getNodesInFile('backend.h');
            const cppNodes = graph.getNodesInFile('backend.cpp');
            const qmlNodes = graph.getNodesInFile('Main.qml');
            const signal = headers.find((node) => node.qualifiedName === 'demo::Backend::updated');
            const otherSignal = headers.find((node) => node.qualifiedName === 'other::Backend::updated');
            const refresh = cppNodes.find((node) => node.qualifiedName === 'demo::Backend::refresh');
            const apply = cppNodes.find((node) => node.qualifiedName === 'demo::Backend::apply');
            const save = cppNodes.find((node) => node.name === 'save');
            const finish = qmlNodes.find((node) => node.name === 'finish');
            expect(signal).toBeDefined();
            expect(otherSignal).toBeDefined();
            expect(refresh).toBeDefined();
            expect(apply).toBeDefined();
            expect(headers.find((node) => node.name === 'FriendlyBackend')?.signature).toBe('QML_NAMED_ELEMENT(FriendlyBackend) owner demo::Backend');
            expect(cppNodes.find((node) => node.name === 'reportService')?.signature).toBe('qt.context-property|reportService|demo::Backend');
            const root = qmlNodes.find((node) => node.kind === 'component' && node.name === 'Main');
            const cppClass = headers.find((node) => node.kind === 'class' && node.qualifiedName === 'demo::Backend');
            expect(graph.getOutgoingEdges(root!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'references', target: cppClass!.id }),
            ]));
            for (const name of ['updateReport', 'updateAlias', 'updateRegistry']) {
                const caller = qmlNodes.find((node) => node.name === name);
                expect(graph.getOutgoingEdges(caller!.id).filter((edge) => edge.kind === 'calls').map((edge) => edge.target)).toEqual([refresh!.id]);
            }
            const handlers = qmlNodes.filter((node) => node.name === 'onUpdated').sort((left, right) => left.startLine - right.startLine);
            expect(handlers).toHaveLength(4);
            for (const handler of handlers) {
                expect(graph.getOutgoingEdges(handler.id).filter((edge) => edge.kind === 'references').map((edge) => edge.target)).toEqual([signal!.id]);
                expect(graph.getOutgoingEdges(signal!.id)).toEqual(expect.arrayContaining([
                    expect.objectContaining({ kind: 'calls', target: handler.id, metadata: expect.objectContaining({ synthesizedBy: 'qt-signal-channel' }) }),
                ]));
            }
            expect(graph.getOutgoingEdges(handlers[1]!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: refresh!.id }),
                expect.objectContaining({ kind: 'calls', target: finish!.id }),
            ]));
            expect(graph.getOutgoingEdges(handlers[2]!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: apply!.id }),
                expect.objectContaining({ kind: 'calls', target: finish!.id }),
            ]));
            for (const target of [refresh!, apply!]) {
                expect(graph.getOutgoingEdges(target.id)).toEqual(expect.arrayContaining([
                    expect.objectContaining({ kind: 'calls', target: save!.id }),
                ]));
            }
            expect(graph.getOutgoingEdges(otherSignal!.id).some((edge) => edge.metadata?.synthesizedBy === 'qt-signal-channel')).toBe(false);
            const nonSignalHandler = qmlNodes.find((node) => node.name === 'onRefresh');
            expect(graph.getOutgoingEdges(nonSignalHandler!.id).filter((edge) => edge.kind === 'references')).toEqual([]);
        } finally {
            graph.close();
        }
    });

    it('resolves multiline constructor defaults and context signal calls through both Connections forms', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-context-defaults-'));
        const header = `#include <QObject>
class Backend : public QObject {
    Q_OBJECT
signals:
    void checkingDRCCompleted();
    void checkingLVSCompleted();
public slots:
    void apply();
public:
    void ordinary();
    Q_INVOKABLE QString saveFileDialog(
        const QStringList& nameFilters = QStringList(QString(), QString()),
        const QString& defaultSuffix = QString(),
        const QString& suggestedPath = QString(QString())
    ); Q_INVOKABLE void ignored();
    Q_INVOKABLE bool validateFile(const QString& file = QString());
    Q_INVOKABLE QString openExistingFileDialog(const QStringList& filters = QStringList());
};
`;
        fs.writeFileSync(path.join(tempDir, 'backend.h'), header);
        fs.writeFileSync(path.join(tempDir, 'backend.cpp'), `#include <QQmlContext>
#include "backend.h"
QString Backend::saveFileDialog(const QStringList& filters, const QString& suffix, const QString& path) { return QString(); }
bool Backend::validateFile(const QString& path) { return true; }
QString Backend::openExistingFileDialog(const QStringList& filters) { return QString(); }
void Backend::checkingDRCCompleted() {}
void Backend::checkingLVSCompleted() {}
void Backend::apply() {}
void Backend::ordinary() {}
void expose(QQmlContext *context, Backend *vrf) {
    context->setContextProperty("reportService", QVariant::fromValue(vrf));
}
`);
        fs.writeFileSync(path.join(tempDir, 'Main.qml'), `import QtQuick
Item {
    function save() { reportService.saveFileDialog() }
    function validate() { reportService.validateFile() }
    function open() { reportService.openExistingFileDialog() }
    function runDRC() { reportService.checkingDRCCompleted() }
    function runLVS() { reportService.checkingLVSCompleted() }
    function runSlot() { reportService.apply() }
    function runOrdinary() { reportService.ordinary() }
    function runMissing() { reportService.setDRCParameters() }
    Connections {
        target: reportService
        function onCheckingDRCCompleted() { finishDRC() }
        function onSaveFileDialog() {}
        function onApply() {}
        function onOrdinary() {}
    }
    Connections {
        target: reportService
        onCheckingLVSCompleted: { finishLVS() }
    }
    function finishDRC() {}
    function finishLVS() {}
}
`);
        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const headers = graph.getNodesInFile('backend.h');
            const cppNodes = graph.getNodesInFile('backend.cpp');
            const qmlNodes = graph.getNodesInFile('Main.qml');
            expect(cppNodes.find((node) => node.name === 'reportService')?.signature).toBe('qt.context-property|reportService|Backend');
            const declaration = headers.find((node) => node.signature?.startsWith('invokable saveFileDialog('));
            const headerLines = header.split('\n');
            expect(declaration).toMatchObject({
                startLine: headerLines.findIndex((line) => line.includes('Q_INVOKABLE QString saveFileDialog(')) + 1,
                endLine: headerLines.findIndex((line) => line.includes('); Q_INVOKABLE void ignored();')) + 1,
                endColumn: '    );'.length,
                signature: 'invokable saveFileDialog(const QStringList& nameFilters = QStringList(QString(), QString()), const QString& defaultSuffix = QString(), const QString& suggestedPath = QString(QString()))',
            });
            for (const [callerName, methodName] of [['save', 'saveFileDialog'], ['validate', 'validateFile'], ['open', 'openExistingFileDialog'], ['runSlot', 'apply']]) {
                const caller = qmlNodes.find((node) => node.name === callerName);
                const implementation = cppNodes.find((node) => node.qualifiedName === `Backend::${methodName}`);
                expect(caller).toBeDefined();
                expect(implementation).toBeDefined();
                expect(graph.getOutgoingEdges(caller!.id).filter((edge) => edge.kind === 'calls').map((edge) => edge.target)).toEqual([implementation!.id]);
            }
            for (const [callerName, signalName, handlerName, helperName] of [
                ['runDRC', 'checkingDRCCompleted', 'onCheckingDRCCompleted', 'finishDRC'],
                ['runLVS', 'checkingLVSCompleted', 'onCheckingLVSCompleted', 'finishLVS'],
            ]) {
                const caller = qmlNodes.find((node) => node.name === callerName);
                const signal = headers.find((node) => node.signature === `signal ${signalName}()`);
                const implementation = cppNodes.find((node) => node.qualifiedName === `Backend::${signalName}`);
                const handler = qmlNodes.find((node) => node.name === handlerName);
                const helper = qmlNodes.find((node) => node.name === helperName);
                for (const node of [caller, signal, implementation, handler, helper]) expect(node).toBeDefined();
                expect(graph.getOutgoingEdges(caller!.id).filter((edge) => edge.kind === 'calls').map((edge) => edge.target)).toEqual([signal!.id]);
                expect(graph.getOutgoingEdges(handler!.id).filter((edge) => edge.kind === 'references').map((edge) => edge.target)).toEqual([signal!.id]);
                expect(graph.getOutgoingEdges(signal!.id)).toEqual(expect.arrayContaining([
                    expect.objectContaining({ kind: 'calls', target: handler!.id, metadata: expect.objectContaining({ synthesizedBy: 'qt-signal-channel' }) }),
                ]));
                expect(graph.getOutgoingEdges(handler!.id).filter((edge) => edge.kind === 'calls').map((edge) => edge.target)).toEqual([helper!.id]);
            }
            for (const name of ['runOrdinary', 'runMissing', 'onSaveFileDialog', 'onApply', 'onOrdinary']) {
                const node = qmlNodes.find((candidate) => candidate.name === name);
                expect(node).toBeDefined();
                expect(graph.getOutgoingEdges(node!.id).filter((edge) => edge.kind === 'calls' || edge.kind === 'references')).toEqual([]);
            }
        } finally {
            graph.close();
        }
    });

    it('rejects unrelated wrappers, non-code registrations, and ambiguous pointer declarations', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-context-negative-'));
        fs.writeFileSync(path.join(tempDir, 'backend.h'), `#include <QObject>
class Backend : public QObject {
    Q_OBJECT
public:
    Q_INVOKABLE void refresh();
};
class Other : public QObject {
    Q_OBJECT
};
`);
        fs.writeFileSync(path.join(tempDir, 'backend.cpp'), `#include <QQmlContext>
#include <QtQml>
#include "backend.h"
void expose(QQmlContext *context, Backend *vrf) {
    context->setContextProperty("unrelatedService", Other::fromValue(vrf));
    // context->setContextProperty("commentService", QVariant::fromValue(vrf));
    /* context->setContextProperty("blockService", vrf); */
    const char *text = R"qt(context->setContextProperty("stringService", QVariant::fromValue(vrf));)qt";
    // qmlRegisterSingletonType<Backend>("Demo.Ui", 1, 0, "CommentRegistry");
    const char *registration = R"qt(qmlRegisterSingletonType<Backend>("Demo.Ui", 1, 0, "StringRegistry");)qt";
}
void ambiguous(QQmlContext *context, Backend *vrf) {
    Other *vrf;
    context->setContextProperty("ambiguousService", QVariant::fromValue(vrf));
}
`);
        const names = ['unrelatedService', 'commentService', 'blockService', 'stringService', 'ambiguousService', 'CommentRegistry', 'StringRegistry'];
        fs.writeFileSync(path.join(tempDir, 'Main.qml'), `import QtQuick\nItem {\n${names.map((name, index) => `    function update${index}() { ${name}.refresh() }`).join('\n')}\n}\n`);
        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            expect(graph.getNodesInFile('backend.cpp').filter((node) => /^(?:qt\.context-property\||qmlRegisterSingletonType<)/.test(node.signature ?? ''))).toEqual([]);
            for (const caller of graph.getNodesInFile('Main.qml').filter((node) => node.name.startsWith('update'))) {
                expect(graph.getOutgoingEdges(caller.id).filter((edge) => edge.kind === 'calls')).toEqual([]);
            }
        } finally {
            graph.close();
        }
    });

    it('leaves ambiguous context owners, registrations and invokable overloads unresolved', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-context-ambiguous-'));
        for (const namespaceName of ['a', 'b']) {
            fs.writeFileSync(path.join(tempDir, `${namespaceName}.h`), `#include <QObject>
namespace ${namespaceName} {
class Backend : public QObject {
    Q_OBJECT
signals:
    void updated();
public:
    Q_INVOKABLE void refresh(int value);
    Q_INVOKABLE void refresh(double value);
};
}
`);
        }
        fs.writeFileSync(path.join(tempDir, 'backend.cpp'), `#include <QQmlContext>
#include <QtQml>
#include "a.h"
#include "b.h"
void expose(QQmlContext *context, a::Backend *first, b::Backend *second) {
    context->setContextProperty("reportService", QVariant::fromValue(first));
    context->setContextProperty("reportService", QVariant::fromValue(second));
    context->setContextProperty("uniqueService", QVariant::fromValue(first));
    qmlRegisterSingletonType<a::Backend>("Demo.Ui", 1, 0, "Registry");
    qmlRegisterSingletonType<b::Backend>("Demo.Ui", 1, 0, "Registry");
}
void a::Backend::refresh(int value) {}
void a::Backend::refresh(double value) {}
`);
        fs.writeFileSync(path.join(tempDir, 'Main.qml'), `import QtQuick
Item {
    function updateAmbiguous() { reportService.refresh(1) }
    function updateOverloaded() { uniqueService.refresh(1) }
    function updateRegistry() { Registry.refresh(1) }
    Connections {
        target: reportService
        function onUpdated() {}
    }
    Connections {
        target: Registry
        onUpdated: {}
    }
}
`);
        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            for (const node of graph.getNodesInFile('Main.qml').filter((node) => node.name.startsWith('update') || node.name === 'onUpdated')) {
                expect(graph.getOutgoingEdges(node.id).filter((edge) => edge.kind === 'calls' || edge.kind === 'references')).toEqual([]);
            }
        } finally {
            graph.close();
        }
    });

    it('reindexes a modified QML file during sync', async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-sync-'));
        const filePath = path.join(tempDir, 'Main.qml');
        fs.writeFileSync(filePath, 'import QtQuick\nItem {\n    function original() {}\n}\n');

        const graph = CodeGraph.initSync(tempDir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            expect(graph.searchNodes('original')).toHaveLength(1);

            fs.writeFileSync(filePath, 'import QtQuick\nItem {\n    function updated() {}\n}\n');

            const result = await graph.sync();
            expect(result.filesModified).toBe(1);
            expect(graph.searchNodes('original')).toHaveLength(0);
            expect(graph.searchNodes('updated')).toHaveLength(1);
        } finally {
            graph.close();
        }
    });

  describe('implicit change signals of QML properties', () => {
    const indexProject = async (files: Record<string, string>) => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qml-prop-changed-'));
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(tempDir, name), content);
      const graph = CodeGraph.initSync(tempDir);
      expect((await graph.indexAll()).success).toBe(true);
      return graph;
    };

    it('links onCountChanged on an instance to the property declared in the type', async () => {
      const graph = await indexProject({
        'Counter.qml': 'import QtQuick 2.15\nItem {\n  property int count: 0\n}\n',
        'Main.qml': 'import QtQuick 2.15\nItem {\n  Counter {\n    onCountChanged: console.log(count)\n  }\n}\n',
      });
      try {
        const property = graph.getNodesInFile('Counter.qml').find((node) => node.kind === 'property' && node.name === 'count')!;
        const handler = graph.getNodesInFile('Main.qml').find((node) => node.name === 'onCountChanged')!;
        expect(graph.getOutgoingEdges(handler.id).some((edge) => edge.target === property.id && edge.kind === 'references')).toBe(true);
      } finally {
        graph.close();
      }
    });

    it('does not guess when two components declare the same property', async () => {
      const graph = await indexProject({
        'Counter.qml': 'import QtQuick 2.15\nItem {\n  property int count: 0\n  Item {\n    property int count: 1\n  }\n}\n',
        'Main.qml': 'import QtQuick 2.15\nItem {\n  Counter {\n    onCountChanged: console.log(count)\n  }\n}\n',
      });
      try {
        const handler = graph.getNodesInFile('Main.qml').find((node) => node.name === 'onCountChanged')!;
        expect(graph.getOutgoingEdges(handler.id).filter((edge) => edge.kind === 'references')).toEqual([]);
      } finally {
        graph.close();
      }
    });
  });
});