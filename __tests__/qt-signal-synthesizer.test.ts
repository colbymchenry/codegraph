import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { initGrammars } from '../src/extraction/grammars';
import { ToolHandler } from '../src/mcp/tools';
import { qtResolver } from '../src/resolution/frameworks/qt';

beforeAll(async () => {
  await initGrammars();
});

describe('Qt signal channel synthesizer', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (filePath: string, content: string) => {
    fs.writeFileSync(path.join(dir, filePath), content);
  };

  it('links emit through its signal to a resolved QML handler and both connect syntaxes to slots', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-signal-'));
    write('sender.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
public:
    void publish();
};
class PointerSender : public QObject {
    Q_OBJECT
signals:
    void refreshed();
};
`);
    write('receiver.h', `#include <QObject>
class Receiver : public QObject {
    Q_OBJECT
public slots:
    void apply();
};
class PointerReceiver : public QObject {
    Q_OBJECT
public slots:
    void update();
};
`);
    write('sender.cpp', `#include "sender.h"
void Sender::publish() {
    emit changed();
}
`);
    write('connections.cpp', `#include "sender.h"
#include "receiver.h"
void wireMacro(Sender *sender, Receiver *receiver) {
    QObject::connect(sender, SIGNAL(changed()), receiver, SLOT(apply()));
}
void wirePointer(PointerSender *sender, PointerReceiver *receiver) {
    QObject::connect(sender, &PointerSender::refreshed, receiver, &PointerReceiver::update);
}
`);
    write('Main.qml', `import QtQuick
Item {
    Sender {
        onChanged: {}
    }
}
`);

    const graph = CodeGraph.initSync(dir);
    try {
      expect((await graph.indexAll()).success).toBe(true);

      const publish = graph.getNodesInFile('sender.cpp').find((node) => node.name === 'publish');
      const senderNodes = graph.getNodesInFile('sender.h');
      const receiverNodes = graph.getNodesInFile('receiver.h');
      const changed = senderNodes.find((node) => node.name === 'changed');
      const refreshed = senderNodes.find((node) => node.name === 'refreshed');
      const apply = receiverNodes.find((node) => node.name === 'apply');
      const update = receiverNodes.find((node) => node.name === 'update');
      const onChanged = graph.getNodesInFile('Main.qml').find((node) => node.name === 'onChanged');

      expect(publish).toBeDefined();
      expect(changed).toBeDefined();
      expect(refreshed).toBeDefined();
      expect(apply).toBeDefined();
      expect(update).toBeDefined();
      expect(onChanged).toBeDefined();

      const synthesized = (sourceId: string, targetId: string) =>
        graph.getOutgoingEdges(sourceId).find(
          (edge) =>
            edge.kind === 'calls' &&
            edge.target === targetId &&
            edge.provenance === 'heuristic' &&
            edge.metadata?.synthesizedBy === 'qt-signal-channel',
        );

      expect(synthesized(publish!.id, changed!.id)).toMatchObject({
        metadata: expect.objectContaining({ registeredAt: 'sender.cpp:3' }),
      });
      expect(graph.getOutgoingEdges(onChanged!.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'references', target: changed!.id }),
      ]));
      expect(graph.getOutgoingEdges(onChanged!.id)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'calls', target: changed!.id }),
      ]));
      expect(synthesized(changed!.id, onChanged!.id)).toMatchObject({
        metadata: expect.objectContaining({ registeredAt: 'Main.qml:4' }),
      });
      expect(synthesized(changed!.id, apply!.id)).toMatchObject({
        metadata: expect.objectContaining({ registeredAt: 'connections.cpp:4' }),
      });
      expect(synthesized(refreshed!.id, update!.id)).toMatchObject({
        metadata: expect.objectContaining({ registeredAt: 'connections.cpp:7' }),
      });
    } finally {
      graph.close();
    }
  });

    it('connects a signal to its slot implementation and exposes the complete save flow', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-slot-body-'));
        write('backend.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
};
class Receiver : public QObject {
    Q_OBJECT
public slots:
    void apply();
};
`);
        write('backend.cpp', `#include "backend.h"
void save() {}
  void apply() {}
void Receiver::apply() { save(); }
void wire(Sender *sender, Receiver *receiver) {
    QObject::connect(sender, &Sender::changed, receiver, &Receiver::apply);
}
`);
        const graph = CodeGraph.initSync(dir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const signal = graph.getNodesInFile('backend.h').find((node) => node.signature?.startsWith('signal '));
            const declaration = graph.getNodesInFile('backend.h').find((node) => node.signature?.startsWith('slot '));
            const implementation = graph.getNodesInFile('backend.cpp').find((node) => node.qualifiedName === 'Receiver::apply');
            const save = graph.getNodesInFile('backend.cpp').find((node) => node.name === 'save');
            expect(signal).toBeDefined();
            expect(declaration).toBeDefined();
            expect(implementation).toBeDefined();
            expect(save).toBeDefined();
            expect(graph.getOutgoingEdges(signal!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: implementation!.id }),
            ]));
            expect(graph.getOutgoingEdges(signal!.id).some((edge) => edge.target === declaration!.id)).toBe(false);
            expect(graph.getOutgoingEdges(implementation!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: save!.id }),
            ]));
            const handler = new ToolHandler(graph);
            for (const query of ['changed apply save', 'changed save']) {
                const result = await handler.execute('codegraph_explore', { query });
                const text = result.content?.[0]?.text ?? '';
                const flow = text.slice(0, text.indexOf('\n## '));
                expect(flow).toMatch(/\*\*Flow/);
                expect(flow).toMatch(/changed[\s\S]*apply[\s\S]*save/);
            }
        } finally {
            graph.close();
        }
    });

    it.each([
        ['int value', 'QString value', false],
        ['int value', 'int value, bool enabled', false],
        ['const QString& input, int value = 0', 'const QString & renamed, int result', true],
    ])('checks slot parameter types before using a sole body: %s / %s', async (declaredParameters, implementedParameters, matches) => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-slot-parameters-'));
        write('backend.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed(${declaredParameters});
};
class Receiver : public QObject {
    Q_OBJECT
public slots:
    void apply(${declaredParameters});
};
`);
        write('backend.cpp', `#include "backend.h"
void Receiver::apply(${implementedParameters}) {}
void wire(Sender *sender, Receiver *receiver) {
    QObject::connect(sender, &Sender::changed, receiver, &Receiver::apply);
}
`);
        const graph = CodeGraph.initSync(dir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const signal = graph.getNodesInFile('backend.h').find((node) => node.signature?.startsWith('signal '));
            const declaration = graph.getNodesInFile('backend.h').find((node) => node.signature?.startsWith('slot '));
            const implementation = graph.getNodesInFile('backend.cpp').find((node) => node.qualifiedName === 'Receiver::apply');
            expect(signal).toBeDefined();
            expect(declaration).toBeDefined();
            expect(implementation).toBeDefined();
            const targets = graph.getOutgoingEdges(signal!.id).filter((edge) => edge.kind === 'calls').map((edge) => edge.target);
            expect(targets).toEqual([matches ? implementation!.id : declaration!.id]);
        } finally {
            graph.close();
        }
    });

    it('does not extract Qt declarations or connections from comments and literals', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-non-code-'));
        const source = `#include <QObject>
  /*
  class Fake : public QObject {
    Q_OBJECT
  signals:
    void fakeSignal();
  public slots:
    void fakeSlot();
    Q_PROPERTY(int fakeProperty READ fakeGetter)
    QML_NAMED_ELEMENT(FakeElement)
  };
  QObject::connect(sender, &Sender::changed, receiver, &Receiver::apply);
  */
  const char *literal = R"qt(
  class FakeLiteral {
    Q_OBJECT
  public:
    Q_INVOKABLE void fakeInvokable();
  };
  QObject::connect(sender, SIGNAL(changed()), receiver, SLOT(apply()));
  )qt";
  `;
        expect(qtResolver.extract!('fake.cpp', source)).toEqual({ nodes: [], references: [] });
    });

    it('keeps executable registrations with quoted Qt includes while ignoring non-code include markers', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-quoted-include-'));
        const result = qtResolver.extract!('register.cpp', `/*
#include "QtQml"
*/
#include "QtQml"
void registerTypes() {
    qmlRegisterType<demo::Backend>("Demo.Ui", 1, 0, "FriendlyBackend");
}
`);
        expect(result.nodes).toEqual([
            expect.objectContaining({ name: 'FriendlyBackend', signature: 'qmlRegisterType<demo::Backend>("FriendlyBackend") from "Demo.Ui"' }),
        ]);
        expect(qtResolver.extract!('fake.cpp', `const char *text = R"qt(
#include "QtQml"
)qt";
void registerTypes() {
    qmlRegisterType<demo::Backend>("Demo.Ui", 1, 0, "FriendlyBackend");
}
`)).toEqual({ nodes: [], references: [] });
    });

    it('does not synthesize emit or connect calls hidden in comments and literals', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-comment-channel-'));
        write('backend.h', `#include <QObject>
  class Sender : public QObject {
    Q_OBJECT
  signals:
    void changed();
  public:
    void publish();
  };
  class Receiver : public QObject {
    Q_OBJECT
  public slots:
    void apply();
  };
  `);
        write('backend.cpp', `#include "backend.h"
  void Sender::publish() {
    // emit changed();
    const char *text = "emit changed();";
    const char *raw = R"qt(emit changed();)qt";
  }
  void wire(Sender *sender, Receiver *receiver) {
    // QObject::connect(sender, &Sender::changed, receiver, &Receiver::apply);
    /* QObject::connect(sender, SIGNAL(changed()), receiver, SLOT(apply())); */
    const char *text = R"qt(QObject::connect(sender, &Sender::changed, receiver, &Receiver::apply);)qt";
  }
  `);
        const graph = CodeGraph.initSync(dir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const nodes = [...graph.getNodesInFile('backend.h'), ...graph.getNodesInFile('backend.cpp')];
            expect(nodes.some((node) => node.name === 'changed')).toBe(true);
            const edges = nodes.flatMap((node) => graph.getOutgoingEdges(node.id));
            expect(edges.filter((edge) => edge.metadata?.synthesizedBy === 'qt-signal-channel')).toEqual([]);
        } finally {
            graph.close();
        }
    });

    it('preserves namespace identity for signals, emits, and modern connections', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-namespace-channel-'));
        for (const namespaceName of ['a', 'b']) {
            write(`${namespaceName}.h`, `#include <QObject>
  namespace ${namespaceName} {
  class Sender : public QObject {
    Q_OBJECT
  signals:
    void changed();
  public:
    void publish();
  };
  class Receiver : public QObject {
    Q_OBJECT
  public slots:
    void apply();
  };
  }
  `);
        }
        write('backend.cpp', `#include "a.h"
  #include "b.h"
  void save() {}
  void a::Sender::publish() { emit changed(); }
  void a::Receiver::apply() { save(); }
  void b::Receiver::apply() {}
  void wire(a::Sender *sender, a::Receiver *receiver) {
    QObject::connect(sender, &a::Sender::changed, receiver, &a::Receiver::apply);
  }
  void unknown(Sender *sender, Receiver *receiver) {
    QObject::connect(sender, &Sender::changed, receiver, &Receiver::apply);
  }
  `);
        const graph = CodeGraph.initSync(dir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const first = graph.getNodesInFile('a.h').find((node) => node.signature?.startsWith('signal '));
            const second = graph.getNodesInFile('b.h').find((node) => node.signature?.startsWith('signal '));
            const cppNodes = graph.getNodesInFile('backend.cpp');
            const publish = cppNodes.find((node) => node.qualifiedName === 'a::Sender::publish');
            const apply = cppNodes.find((node) => node.qualifiedName === 'a::Receiver::apply');
            const otherApply = cppNodes.find((node) => node.qualifiedName === 'b::Receiver::apply');
            expect(first?.qualifiedName).toBe('a::Sender::changed');
            expect(second?.qualifiedName).toBe('b::Sender::changed');
            expect(publish).toBeDefined();
            expect(apply).toBeDefined();
            expect(otherApply).toBeDefined();
            expect(graph.getOutgoingEdges(publish!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: first!.id }),
            ]));
            expect(graph.getOutgoingEdges(first!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: apply!.id }),
            ]));
            expect(graph.getOutgoingEdges(first!.id).some((edge) => edge.target === otherApply!.id)).toBe(false);
            expect(graph.getOutgoingEdges(second!.id).some((edge) => edge.metadata?.synthesizedBy === 'qt-signal-channel')).toBe(false);
        } finally {
            graph.close();
        }
    });

    it('does not pick an implementation among same-arity overloads', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-overloaded-slot-'));
        write('backend.h', `#include <QObject>
  class Sender : public QObject {
    Q_OBJECT
  signals:
    void changed(int value);
  };
  class Receiver : public QObject {
    Q_OBJECT
  public slots:
    void apply(int value);
  };
  `);
        write('backend.cpp', `#include "backend.h"
  void Receiver::apply(int value) {}
  void Receiver::apply(double value) {}
  void wire(Sender *sender, Receiver *receiver) {
    QObject::connect(sender, &Sender::changed, receiver, &Receiver::apply);
  }
  `);
        const graph = CodeGraph.initSync(dir);
        try {
            expect((await graph.indexAll()).success).toBe(true);
            const signal = graph.getNodesInFile('backend.h').find((node) => node.signature?.startsWith('signal '));
            const declaration = graph.getNodesInFile('backend.h').find((node) => node.signature?.startsWith('slot '));
            const implementations = graph.getNodesInFile('backend.cpp').filter((node) => node.name === 'apply');
            expect(implementations).toHaveLength(2);
            expect(graph.getOutgoingEdges(signal!.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ kind: 'calls', target: declaration!.id }),
            ]));
            expect(graph.getOutgoingEdges(signal!.id).some((edge) => implementations.some((node) => node.id === edge.target))).toBe(false);
        } finally {
            graph.close();
        }
    });

    it('does not synthesize a SIGNAL/SLOT connection with an ambiguous signal owner', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-signal-ambiguous-'));
    write('first.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
};
`);
    write('second.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
};
`);
    write('receiver.h', `#include <QObject>
class Receiver : public QObject {
    Q_OBJECT
public slots:
    void apply();
};
`);
    write('connections.cpp', `#include "first.h"
#include "receiver.h"
void wire(Sender *sender, Receiver *receiver) {
    QObject::connect(sender, SIGNAL(changed()), receiver, SLOT(apply()));
}
`);

    const graph = CodeGraph.initSync(dir);
    try {
      expect((await graph.indexAll()).success).toBe(true);
      const signals = ['first.h', 'second.h'].flatMap((filePath) =>
        graph.getNodesInFile(filePath).filter((node) => node.name === 'changed'),
      );
      const slot = graph.getNodesInFile('receiver.h').find((node) => node.name === 'apply');

      expect(signals).toHaveLength(2);
      expect(slot).toBeDefined();
      for (const signal of signals) {
        expect(graph.getOutgoingEdges(signal.id)).not.toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'calls',
            target: slot!.id,
            provenance: 'heuristic',
            metadata: expect.objectContaining({ synthesizedBy: 'qt-signal-channel' }),
          }),
        ]));
      }
    } finally {
      graph.close();
    }
  });

  describe('namespace-aware connect and emit resolution', () => {
    const indexAndCollect = async () => {
      const graph = CodeGraph.initSync(dir);
      expect((await graph.indexAll()).success).toBe(true);
      const synthesized = (filePaths: string[]) =>
        filePaths
          .flatMap((filePath) => graph.getNodesInFile(filePath))
          .flatMap((node) => graph.getOutgoingEdges(node.id))
          .filter((edge) => edge.metadata?.synthesizedBy === 'qt-signal-channel');
      const find = (filePath: string, name: string, signaturePrefix?: string) =>
        graph.getNodesInFile(filePath).find((node) =>
          node.name === name && (!signaturePrefix || node.signature?.startsWith(signaturePrefix)));
      return { graph, synthesized, find };
    };

    const vrfHeader = `#include <QObject>
namespace vrf {
class Verification : public QObject {
    Q_OBJECT
signals:
    void pidRegistration(int pid);
public slots:
    void registerPid(int pid);
public:
    void wire(Verification *other);
};
}
`;

    it('resolves a pointer connect written inside a namespace with unqualified owners', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-ns-pointer-'));
      write('verification.h', vrfHeader);
      write('verification.cpp', `#include "verification.h"
namespace vrf {
void Verification::wire(Verification *other) {
  connect(other, &Verification::pidRegistration, this, &Verification::registerPid);
}
}
`);
      const { graph, synthesized, find } = await indexAndCollect();
      try {
        const signal = find('verification.h', 'pidRegistration', 'signal ');
        expect(signal).toBeDefined();
        const edge = synthesized(['verification.h', 'verification.cpp'])
          .find((candidate) => candidate.source === signal!.id && candidate.metadata?.connection === 'pointer');
        expect(edge).toBeDefined();
        expect(graph.getNode(edge!.target)?.name).toBe('registerPid');
        expect(edge!.metadata).toMatchObject({ registeredAt: 'verification.cpp:4' });
      } finally {
        graph.close();
      }
    });

    it('resolves owners through a using-namespace directive', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-using-'));
      write('verification.h', vrfHeader);
      write('wiring.cpp', `#include "verification.h"
using namespace vrf;
void wire(Verification *a, Verification *b) {
  QObject::connect(a, &Verification::pidRegistration, b, &Verification::registerPid);
}
`);
      const { graph, synthesized, find } = await indexAndCollect();
      try {
        const signal = find('verification.h', 'pidRegistration', 'signal ');
        const edge = synthesized(['verification.h', 'wiring.cpp']).find((candidate) => candidate.source === signal!.id);
        expect(edge).toBeDefined();
        expect(graph.getNode(edge!.target)?.name).toBe('registerPid');
      } finally {
        graph.close();
      }
    });

    it('prefers the innermost namespace when two namespaces declare the same class name', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-ns-inner-'));
      for (const namespaceName of ['a', 'b']) {
        write(`${namespaceName}.h`, `#include <QObject>
namespace ${namespaceName} {
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
};
class Receiver : public QObject {
    Q_OBJECT
public slots:
    void apply();
};
}
`);
      }
      write('wiring.cpp', `#include "a.h"
#include "b.h"
namespace a {
void wire(Sender *sender, Receiver *receiver) {
  QObject::connect(sender, &Sender::changed, receiver, &Receiver::apply);
}
}
`);
      const { graph, synthesized, find } = await indexAndCollect();
      try {
        const first = find('a.h', 'changed', 'signal ')!;
        const second = find('b.h', 'changed', 'signal ')!;
        const firstApply = find('a.h', 'apply', 'slot ')!;
        const edges = synthesized(['a.h', 'b.h', 'wiring.cpp']);
        expect(edges.some((edge) => edge.source === first.id && edge.target === firstApply.id)).toBe(true);
        expect(edges.some((edge) => edge.source === second.id)).toBe(false);
      } finally {
        graph.close();
      }
    });

    it('does not guess when an unqualified owner matches classes in two namespaces', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-ns-ambiguous-'));
      for (const namespaceName of ['a', 'b']) {
        write(`${namespaceName}.h`, `#include <QObject>
namespace ${namespaceName} {
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
};
}
`);
      }
      write('receiver.h', `#include <QObject>
class Receiver : public QObject {
    Q_OBJECT
public slots:
    void apply();
};
`);
      write('wiring.cpp', `#include "a.h"
#include "b.h"
#include "receiver.h"
using namespace a;
using namespace b;
void wire(Sender *sender, Receiver *receiver) {
  QObject::connect(sender, &Sender::changed, receiver, &Receiver::apply);
}
`);
      const { graph, synthesized } = await indexAndCollect();
      try {
        expect(synthesized(['a.h', 'b.h', 'receiver.h', 'wiring.cpp'])).toEqual([]);
      } finally {
        graph.close();
      }
    });

    it('treats Q_EMIT like emit and records the call site', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-q-emit-'));
      write('sender.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void changed();
public:
    void publish();
};
`);
      write('sender.cpp', `#include "sender.h"
void Sender::publish() {
  Q_EMIT changed();
}
`);
      const { graph, synthesized, find } = await indexAndCollect();
      try {
        const publish = find('sender.cpp', 'publish')!;
        const changed = find('sender.h', 'changed', 'signal ')!;
        const edge = synthesized(['sender.cpp']).find((candidate) => candidate.source === publish.id);
        expect(edge).toMatchObject({ target: changed.id, metadata: expect.objectContaining({ registeredAt: 'sender.cpp:3' }) });
      } finally {
        graph.close();
      }
    });

    it('resolves this as sender and receiver, and the three-argument connect', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-this-'));
      write('widget.h', `#include <QObject>
class Widget : public QObject {
    Q_OBJECT
signals:
    void opened();
    void closed();
public slots:
    void apply();
    void cleanup();
public:
    void setup();
};
`);
      write('widget.cpp', `#include "widget.h"
void Widget::setup() {
  connect(this, SIGNAL(opened()), this, SLOT(apply()));
  connect(this, SIGNAL(closed()), SLOT(cleanup()));
}
`);
      const { graph, synthesized, find } = await indexAndCollect();
      try {
        const edges = synthesized(['widget.h', 'widget.cpp']);
        const targetOf = (signalName: string) =>
          graph.getNode(edges.find((edge) => edge.source === find('widget.h', signalName, 'signal ')!.id)?.target ?? '')?.name;
        expect(targetOf('opened')).toBe('apply');
        expect(targetOf('closed')).toBe('cleanup');
      } finally {
        graph.close();
      }
    });

    it('connects a signal to an ordinary method outside any slots section', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-plain-method-'));
      write('backend.h', `#include <QObject>
class Sender : public QObject {
    Q_OBJECT
signals:
    void refreshed();
};
class Receiver : public QObject {
    Q_OBJECT
public:
    void update();
};
`);
      write('backend.cpp', `#include "backend.h"
void Receiver::update() {}
void wire(Sender *sender, Receiver *receiver) {
  QObject::connect(sender, &Sender::refreshed, receiver, &Receiver::update);
}
`);
      const { graph, synthesized, find } = await indexAndCollect();
      try {
        const signal = find('backend.h', 'refreshed', 'signal ')!;
        const edge = synthesized(['backend.h', 'backend.cpp']).find((candidate) => candidate.source === signal.id);
        expect(edge).toBeDefined();
        const target = graph.getNode(edge!.target)!;
        expect(target.name).toBe('update');
        expect(target.filePath).toBe('backend.cpp');
      } finally {
        graph.close();
      }
    });

    it('does not pair the arguments of two neighbouring connect statements', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-neighbours-'));
      write('backend.h', `#include <QObject>
class Worker : public QObject {
    Q_OBJECT
signals:
    void started();
    void finished();
public slots:
    void onFinished();
public:
    void wire();
};
`);
      write('backend.cpp', `#include "backend.h"
void Worker::wire() {
  connect(this, &Worker::started, &Worker::onFinished);
  connect(this, &Worker::finished, this, &Worker::onFinished);
}
`);
      const { graph, synthesized, find } = await indexAndCollect();
      try {
        const edges = synthesized(['backend.h', 'backend.cpp']);
        const started = find('backend.h', 'started', 'signal ')!;
        const finished = find('backend.h', 'finished', 'signal ')!;
        expect(edges.some((edge) => edge.source === started.id)).toBe(false);
        expect(edges.filter((edge) => edge.source === finished.id).map((edge) => graph.getNode(edge.target)?.name)).toEqual(['onFinished']);
        expect(edges.some((edge) => edge.source === started.id && edge.target === finished.id)).toBe(false);
      } finally {
        graph.close();
      }
    });

    it('chains one signal into another in both connect syntaxes', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qt-signal-chain-'));
      write('backend.h', `#include <QObject>
class Source : public QObject {
    Q_OBJECT
signals:
    void first();
    void third();
};
class Relay : public QObject {
    Q_OBJECT
signals:
    void second();
    void fourth();
};
`);
      write('backend.cpp', `#include "backend.h"
void wire(Source *source, Relay *relay) {
  QObject::connect(source, &Source::first, relay, &Relay::second);
  QObject::connect(source, SIGNAL(third()), relay, SIGNAL(fourth()));
}
`);
      const { graph, synthesized, find } = await indexAndCollect();
      try {
        const edges = synthesized(['backend.h', 'backend.cpp']);
        const linked = (from: string, to: string) =>
          edges.some((edge) =>
            edge.source === find('backend.h', from, 'signal ')!.id && edge.target === find('backend.h', to, 'signal ')!.id);
        expect(linked('first', 'second')).toBe(true);
        expect(linked('third', 'fourth')).toBe(true);
      } finally {
        graph.close();
      }
    });
  });
});