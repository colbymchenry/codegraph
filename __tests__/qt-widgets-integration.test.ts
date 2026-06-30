import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';

function methodNodeIdByLine(graph: CodeGraph, filePath: string, methodName: string, lineText: string): string {
  const source = fs.readFileSync(filePath, 'utf-8');
  const startLine = source.split('\n').findIndex((line) => line.includes(lineText)) + 1;
  expect(startLine).toBeGreaterThan(0);
  const fileName = path.basename(filePath);
  const node = graph
    .getNodesByName(methodName)
    .find((candidate) => candidate.kind === 'method' && candidate.filePath === fileName && candidate.startLine === startLine);
  expect(node).toBeDefined();
  return node!.id;
}

describe('Qt Widgets graph support', () => {
  let tmpDir: string;
  let graph: CodeGraph | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qt-widgets-'));
    graph = CodeGraph.initSync(tmpDir);
  });

  afterEach(() => {
    graph?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Qt Widgets projects from QApplication and QWidget usage', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QApplication>
#include <QWidget>

int main(int argc, char **argv) {
  QApplication app(argc, argv);
  QWidget window;
  window.show();
  return app.exec();
}
`
    );

    await graph!.indexAll();

    expect(graph!.getDetectedFrameworks()).toContain('qt');
  });

  it('does not detect Qt Widgets from ordinary C socket connect calls', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.c'),
      `#include <sys/socket.h>

int main() {
  int socketFd = 0;
  struct sockaddr *address = 0;
  return connect(socketFd, address, 0);
}
`
    );

    await graph!.indexAll();

    expect(graph!.getDetectedFrameworks()).not.toContain('qt');
  });

  it('does not detect Qt Widgets from unrelated text files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.txt'), 'Example mentions QApplication.\n');
    fs.writeFileSync(path.join(tmpDir, 'main.c'), 'int main() { return 0; }\n');

    await graph!.indexAll();

    expect(graph!.getDetectedFrameworks()).not.toContain('qt');
  });

  it.skip('resolves new-style connects to the matching duplicate class slot once Task 4 adds synthesis', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QPushButton>

namespace App {
class MainWindow : public QMainWindow {
  Q_OBJECT

public:
  MainWindow();

public slots:
  void onButtonClicked();
};
}

namespace Other {
class MainWindow : public QMainWindow {
  Q_OBJECT

public slots:
  void onButtonClicked();
};
}

App::MainWindow::MainWindow() {
  auto *button = new QPushButton(this);
  connect(button, &QPushButton::clicked, this, &App::MainWindow::onButtonClicked);
}

void App::MainWindow::onButtonClicked() {}
void Other::MainWindow::onButtonClicked() {}
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find(
        (node) =>
          node.kind === 'method' &&
          node.qualifiedName.endsWith('App::MainWindow::MainWindow')
      );
    const appSlot = graph!
      .getNodesByName('onButtonClicked')
      .find(
        (node) =>
          node.kind === 'method' &&
          node.qualifiedName.endsWith('App::MainWindow::onButtonClicked')
      );
    const otherSlot = graph!
      .getNodesByName('onButtonClicked')
      .find(
        (node) =>
          node.kind === 'method' &&
          node.qualifiedName.endsWith('Other::MainWindow::onButtonClicked')
      );

    expect(constructor).toBeDefined();
    expect(appSlot).toBeDefined();
    expect(otherSlot).toBeDefined();

    const outgoingCalls = graph!
      .getOutgoingEdges(constructor!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    expect(outgoingCalls).toContain(appSlot!.id);
    expect(outgoingCalls).not.toContain(otherSlot!.id);
  });

  it('resolves QML C++ bridge methods against qualified duplicate class names', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QObject>
#include <QtQml>

namespace App {
class ViewModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void refresh();
};
}

namespace Other {
class ViewModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void refresh();
};
}

void App::ViewModel::refresh() {}
void Other::ViewModel::refresh() {}

int main() {
  QQmlApplicationEngine engine;
  App::ViewModel appViewModel;
  Other::ViewModel otherViewModel;
  engine.rootContext()->setContextProperty("viewModel", &appViewModel);
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Component.onCompleted: {
    viewModel.refresh()
  }
}
`
    );

    await graph!.indexAll();

    const onCompleted = graph!
      .getNodesByName('Component.onCompleted')
      .find((node) => node.kind === 'method' && node.filePath === 'Main.qml');
    const appRefresh = graph!
      .getNodesByName('refresh')
      .find(
        (node) =>
          node.kind === 'method' && node.qualifiedName.endsWith('App::ViewModel::refresh')
      );
    const otherRefresh = graph!
      .getNodesByName('refresh')
      .find(
        (node) =>
          node.kind === 'method' && node.qualifiedName.endsWith('Other::ViewModel::refresh')
      );

    expect(onCompleted).toBeDefined();
    expect(appRefresh).toBeDefined();
    expect(otherRefresh).toBeDefined();

    const outgoingCalls = graph!
      .getOutgoingEdges(onCompleted!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    expect(outgoingCalls).toContain(appRefresh!.id);
    expect(outgoingCalls).not.toContain(otherRefresh!.id);
  });

  it('keeps QML C++ bridge calls unresolved for same-class overloads', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QObject>
#include <QtQml>
#include <QVector>

class ViewModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void update(int value);
  Q_INVOKABLE void update(QVector<int> values);
};

void ViewModel::update(int value) {}
void ViewModel::update(QVector<int> values) {}

int main() {
  QQmlApplicationEngine engine;
  ViewModel viewModel;
  engine.rootContext()->setContextProperty("viewModel", &viewModel);
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Component.onCompleted: {
    viewModel.update()
  }
}
`
    );

    await graph!.indexAll();

    const onCompleted = graph!
      .getNodesByName('Component.onCompleted')
      .find((node) => node.kind === 'method' && node.filePath === 'Main.qml');
    const updateMethods = graph!
      .getNodesByName('update')
      .filter((node) => node.kind === 'method' && node.qualifiedName.endsWith('ViewModel::update'));

    expect(onCompleted).toBeDefined();
    expect(updateMethods).toHaveLength(2);

    const outgoingCalls = graph!
      .getOutgoingEdges(onCompleted!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    for (const updateMethod of updateMethods) {
      expect(outgoingCalls).not.toContain(updateMethod.id);
    }
  });

  it('resolves QML C++ bridge calls when only one overload is QML-visible', async () => {
    const mainCpp = path.join(tmpDir, 'main.cpp');
    fs.writeFileSync(
      mainCpp,
      `#include <QObject>
#include <QtQml>

class ViewModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void refresh();
private:
  void refresh(int value);
};

void ViewModel::refresh() {}
void ViewModel::refresh(int value) {}

int main() {
  QQmlApplicationEngine engine;
  ViewModel viewModel;
  engine.rootContext()->setContextProperty("viewModel", &viewModel);
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Component.onCompleted: {
    viewModel.refresh()
  }
}
`
    );

    await graph!.indexAll();

    const onCompleted = graph!
      .getNodesByName('Component.onCompleted')
      .find((node) => node.kind === 'method' && node.filePath === 'Main.qml');
    const refreshMethods = graph!
      .getNodesByName('refresh')
      .filter((node) => node.kind === 'method' && node.qualifiedName.endsWith('ViewModel::refresh'));
    const invokableRefresh = methodNodeIdByLine(graph!, mainCpp, 'refresh', 'void ViewModel::refresh()');
    const privateRefresh = methodNodeIdByLine(graph!, mainCpp, 'refresh', 'void ViewModel::refresh(int value)');

    expect(onCompleted).toBeDefined();
    expect(refreshMethods).toHaveLength(2);

    const outgoingCalls = graph!
      .getOutgoingEdges(onCompleted!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    expect(outgoingCalls).toContain(invokableRefresh);
    expect(outgoingCalls).not.toContain(privateRefresh);
  });

  it('resolves QML C++ property reads to zero-arity getters when getter names are overloaded', async () => {
    const mainCpp = path.join(tmpDir, 'main.cpp');
    fs.writeFileSync(
      mainCpp,
      `#include <QObject>
#include <QtQml>

class ViewModel : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString title READ title NOTIFY titleChanged)
public:
  QString title() const;
  QString title(int role) const;
signals:
  void titleChanged();
};

QString ViewModel::title() const { return "ready"; }
QString ViewModel::title(int role) const { return "ready"; }

int main() {
  QQmlApplicationEngine engine;
  ViewModel viewModel;
  engine.rootContext()->setContextProperty("viewModel", &viewModel);
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  property string shownTitle: viewModel.title
}
`
    );

    await graph!.indexAll();

    const shownTitle = graph!
      .getNodesByName('shownTitle')
      .find((node) => node.kind === 'property' && node.filePath === 'Main.qml');
    const titleGetter = methodNodeIdByLine(graph!, mainCpp, 'title', 'QString ViewModel::title() const');
    const titleRoleGetter = methodNodeIdByLine(graph!, mainCpp, 'title', 'QString ViewModel::title(int role) const');

    expect(shownTitle).toBeDefined();
    const outgoingReferences = graph!
      .getOutgoingEdges(shownTitle!.id)
      .filter((edge) => edge.kind === 'references')
      .map((edge) => edge.target);

    expect(outgoingReferences).toContain(titleGetter);
    expect(outgoingReferences).not.toContain(titleRoleGetter);
  });

  it('keeps QML C++ bridge calls unresolved for pointer and reference overloads', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QObject>
#include <QtQml>

class Payload {};

class ViewModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void consume(Payload value);
  Q_INVOKABLE void consume(Payload *value);
  Q_INVOKABLE void consume(Payload &value);
};

void ViewModel::consume(Payload value) {}
void ViewModel::consume(Payload *value) {}
void ViewModel::consume(Payload &value) {}

int main() {
  QQmlApplicationEngine engine;
  ViewModel viewModel;
  engine.rootContext()->setContextProperty("viewModel", &viewModel);
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Component.onCompleted: {
    viewModel.consume()
  }
}
`
    );

    await graph!.indexAll();

    const onCompleted = graph!
      .getNodesByName('Component.onCompleted')
      .find((node) => node.kind === 'method' && node.filePath === 'Main.qml');
    const consumeMethods = graph!
      .getNodesByName('consume')
      .filter((node) => node.kind === 'method' && node.qualifiedName.endsWith('ViewModel::consume'));

    expect(onCompleted).toBeDefined();
    expect(consumeMethods).toHaveLength(3);

    const outgoingCalls = graph!
      .getOutgoingEdges(onCompleted!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    for (const consumeMethod of consumeMethods) {
      expect(outgoingCalls).not.toContain(consumeMethod.id);
    }
  });

  it('deduplicates const Q_INVOKABLE getters across Qt method scans', async () => {
    const mainCpp = path.join(tmpDir, 'main.cpp');
    fs.writeFileSync(
      mainCpp,
      `#include <QObject>
#include <QtQml>

class ViewModel : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString title READ title NOTIFY titleChanged)
public:
  Q_INVOKABLE QString title() const;
signals:
  void titleChanged();
};

QString ViewModel::title() const { return "ready"; }

int main() {
  QQmlApplicationEngine engine;
  ViewModel viewModel;
  engine.rootContext()->setContextProperty("viewModel", &viewModel);
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  property string shownTitle: viewModel.title
}
`
    );

    await graph!.indexAll();

    const shownTitle = graph!
      .getNodesByName('shownTitle')
      .find((node) => node.kind === 'property' && node.filePath === 'Main.qml');
    const titleGetter = methodNodeIdByLine(graph!, mainCpp, 'title', 'QString ViewModel::title() const');

    expect(shownTitle).toBeDefined();
    expect(
      graph!
        .getOutgoingEdges(shownTitle!.id)
        .some((edge) => edge.kind === 'references' && edge.target === titleGetter)
    ).toBe(true);
  });

  it('resolves QML C++ bridge methods against fully qualified nested namespaces', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QObject>
#include <QtQml>

namespace App {
namespace Ui {
class ViewModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void refresh();
};
}
}

namespace Other {
namespace Ui {
class ViewModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void refresh();
};
}
}

void App::Ui::ViewModel::refresh() {}
void Other::Ui::ViewModel::refresh() {}

int main() {
  QQmlApplicationEngine engine;
  App::Ui::ViewModel appViewModel;
  Other::Ui::ViewModel otherViewModel;
  engine.rootContext()->setContextProperty("viewModel", &appViewModel);
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Component.onCompleted: {
    viewModel.refresh()
  }
}
`
    );

    await graph!.indexAll();

    const onCompleted = graph!
      .getNodesByName('Component.onCompleted')
      .find((node) => node.kind === 'method' && node.filePath === 'Main.qml');
    const appRefresh = graph!
      .getNodesByName('refresh')
      .find(
        (node) =>
          node.kind === 'method' && node.qualifiedName.endsWith('App::Ui::ViewModel::refresh')
      );
    const otherRefresh = graph!
      .getNodesByName('refresh')
      .find(
        (node) =>
          node.kind === 'method' && node.qualifiedName.endsWith('Other::Ui::ViewModel::refresh')
      );

    expect(onCompleted).toBeDefined();
    expect(appRefresh).toBeDefined();
    expect(otherRefresh).toBeDefined();

    const outgoingCalls = graph!
      .getOutgoingEdges(onCompleted!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    expect(outgoingCalls).toContain(appRefresh!.id);
    expect(outgoingCalls).not.toContain(otherRefresh!.id);
  });

  it('resolves QML C++ signal handlers to unique parameterized signals', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QObject>
#include <QtQml>

class ViewModel : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString title READ title NOTIFY titleChanged)
public:
  QString title() const;
signals:
  void titleChanged(const QString &title);
};

QString ViewModel::title() const { return "ready"; }
void ViewModel::titleChanged(const QString &title) {}

int main() {
  QQmlApplicationEngine engine;
  ViewModel viewModel;
  engine.rootContext()->setContextProperty("viewModel", &viewModel);
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Connections {
    target: viewModel
    function onTitleChanged(title) {}
  }
}
`
    );

    await graph!.indexAll();

    const handler = graph!
      .getNodesByName('onTitleChanged')
      .find((node) => node.kind === 'method' && node.filePath === 'Main.qml');
    const signal = graph!
      .getNodesByName('titleChanged')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('ViewModel::titleChanged'));

    expect(handler).toBeDefined();
    expect(signal).toBeDefined();
    expect(
      graph!
        .getOutgoingEdges(handler!.id)
        .some((edge) => edge.kind === 'references' && edge.target === signal!.id)
    ).toBe(true);
  });
});
