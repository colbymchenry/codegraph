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

  function outgoingSynthesizedEdges(sourceId: string, synthesizedBy: string) {
    return graph!
      .getOutgoingEdges(sourceId)
      .filter(
        (edge) =>
          edge.kind === 'calls' &&
          edge.metadata &&
          (edge.metadata as Record<string, unknown>).synthesizedBy === synthesizedBy
      );
  }

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

  it('resolves new-style connects to the matching duplicate class slot', async () => {
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

  it('uses the registration owner for simple receiver class names in duplicate Qt classes', async () => {
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
  connect(button, &QPushButton::clicked, this, &MainWindow::onButtonClicked);
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

  it('does not synthesize member-pointer connect edges for non-Qt C++ APIs', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `class Source {
public:
  void changed();
};

class Receiver {
public:
  void handle();
};

void connect(Source *source, void (Source::*signal)(), Receiver *receiver, void (Receiver::*slot)()) {}

void wire(Source *source, Receiver *receiver) {
  connect(source, &Source::changed, receiver, &Receiver::handle);
}

void Source::changed() {}
void Receiver::handle() {}
`
    );

    await graph!.indexAll();

    const wire = graph!.getNodesByName('wire').find((node) => node.kind === 'function');
    const handle = graph!
      .getNodesByName('handle')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('Receiver::handle'));

    expect(wire).toBeDefined();
    expect(handle).toBeDefined();
    expect(
      graph!
        .getOutgoingEdges(wire!.id)
        .some((edge) => edge.kind === 'calls' && edge.target === handle!.id)
    ).toBe(false);
  });

  it('does not treat this receiver member-pointer connects as Qt evidence by itself', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `class Source {
public:
  void changed();
};

class Receiver {
public:
  void wire(Source *source);
  void handle();
};

void connect(Source *source, void (Source::*signal)(), Receiver *receiver, void (Receiver::*slot)()) {}

void Receiver::wire(Source *source) {
  connect(source, &Source::changed, this, &Receiver::handle);
}

void Source::changed() {}
void Receiver::handle() {}
`
    );

    await graph!.indexAll();

    const wire = graph!
      .getNodesByName('wire')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('Receiver::wire'));
    const handle = graph!
      .getNodesByName('handle')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('Receiver::handle'));

    expect(wire).toBeDefined();
    expect(handle).toBeDefined();
    expect(
      graph!
        .getOutgoingEdges(wire!.id)
        .some((edge) => edge.kind === 'calls' && edge.target === handle!.id)
    ).toBe(false);
  });

  it('does not synthesize custom connect helpers inside Qt classes', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>

class Source {
public:
  void changed();
};

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  void wire(Source *source);
  void handle();
};

void connect(Source *source, void (Source::*signal)(), MainWindow *receiver, void (MainWindow::*slot)()) {}

void MainWindow::wire(Source *source) {
  connect(source, &Source::changed, this, &MainWindow::handle);
}

void Source::changed() {}
void MainWindow::handle() {}
`
    );

    await graph!.indexAll();

    const wire = graph!
      .getNodesByName('wire')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::wire'));
    const handle = graph!
      .getNodesByName('handle')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::handle'));

    expect(wire).toBeDefined();
    expect(handle).toBeDefined();
    expect(
      graph!
        .getOutgoingEdges(wire!.id)
        .some((edge) => edge.kind === 'calls' && edge.target === handle!.id)
    ).toBe(false);
  });

  it('resolves legacy SIGNAL/SLOT connects to the matching slot', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QPushButton>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  void wire(QPushButton *button);
public slots:
  void onClicked();
};

void MainWindow::wire(QPushButton *button) {
  connect(button, SIGNAL(clicked()), this, SLOT(onClicked()));
}

void MainWindow::onClicked() {}
`
    );

    await graph!.indexAll();

    const wire = graph!
      .getNodesByName('wire')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::wire'));
    const onClicked = graph!
      .getNodesByName('onClicked')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::onClicked'));

    expect(wire).toBeDefined();
    expect(onClicked).toBeDefined();
    expect(outgoingSynthesizedEdges(wire!.id, 'qt-widgets-connect').some((edge) => edge.target === onClicked!.id)).toBe(true);
  });

  it('resolves legacy SIGNAL/SLOT connects with typed non-this receivers', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QPushButton>

class PerformanceWidget : public QObject {
  Q_OBJECT
public slots:
  void reload();
};

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  void wire(QPushButton *button);
private:
  PerformanceWidget *m_pPerformanceWidget;
};

void MainWindow::wire(QPushButton *button) {
  connect(button, SIGNAL(clicked()), m_pPerformanceWidget, SLOT(reload()));
}

void PerformanceWidget::reload() {}
`
    );

    await graph!.indexAll();

    const wire = graph!
      .getNodesByName('wire')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::wire'));
    const reload = graph!
      .getNodesByName('reload')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('PerformanceWidget::reload'));

    expect(wire).toBeDefined();
    expect(reload).toBeDefined();
    expect(outgoingSynthesizedEdges(wire!.id, 'qt-widgets-connect').some((edge) => edge.target === reload!.id)).toBe(true);
  });

  it('links emitted Qt signals to slots registered elsewhere', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'login.cpp'),
      `#include <QMainWindow>
#include <QObject>
#include <QPushButton>

class HttpLogin : public QObject {
  Q_OBJECT
public:
  void userLogin(QPushButton *button);
  void slot_userLoginFinish();
signals:
  void signal_userLoginFinish(bool ok);
};

class UserNameLoginPage : public QObject {
  Q_OBJECT
public:
  void initConnections(QPushButton *button);
  void slot_login_button_clicked();
  void loginAfterUpdateCheck();
public slots:
  void slot_loginFinished(bool ok);
signals:
  void signal_httpLoginFinish(bool ok);
};

class LoginWidget : public QMainWindow {
  Q_OBJECT
public:
  void initConnection();
public slots:
  void slot_userLoginFinish(bool ok);
  void slot_triggerAppCheck();
private:
  UserNameLoginPage *loginPage_;
};

void HttpLogin::userLogin(QPushButton *button) {
  connect(button, SIGNAL(clicked()), this, SLOT(slot_userLoginFinish()));
}

void HttpLogin::slot_userLoginFinish() {
  emit signal_userLoginFinish(true);
}

void UserNameLoginPage::initConnections(QPushButton *button) {
  connect(button, &QPushButton::clicked, this, &UserNameLoginPage::slot_login_button_clicked);
}

void UserNameLoginPage::slot_login_button_clicked() {
  loginAfterUpdateCheck();
}

void UserNameLoginPage::loginAfterUpdateCheck() {
  HttpLogin *client = new HttpLogin;
  connect(client, &HttpLogin::signal_userLoginFinish, this, &UserNameLoginPage::slot_loginFinished);
}

void UserNameLoginPage::slot_loginFinished(bool ok) {
  emit signal_httpLoginFinish(ok);
}

void LoginWidget::initConnection() {
  connect(loginPage_, &UserNameLoginPage::signal_httpLoginFinish, this, &LoginWidget::slot_userLoginFinish);
}

void LoginWidget::slot_userLoginFinish(bool ok) {
  if (ok) {
    slot_triggerAppCheck();
  }
}

void LoginWidget::slot_triggerAppCheck() {}
`
    );

    await graph!.indexAll();

    const httpFinish = graph!
      .getNodesByName('slot_userLoginFinish')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('HttpLogin::slot_userLoginFinish'));
    const pageFinish = graph!
      .getNodesByName('slot_loginFinished')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('UserNameLoginPage::slot_loginFinished'));
    const widgetFinish = graph!
      .getNodesByName('slot_userLoginFinish')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('LoginWidget::slot_userLoginFinish'));
    const triggerAppCheck = graph!
      .getNodesByName('slot_triggerAppCheck')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('LoginWidget::slot_triggerAppCheck'));

    expect(httpFinish).toBeDefined();
    expect(pageFinish).toBeDefined();
    expect(widgetFinish).toBeDefined();
    expect(triggerAppCheck).toBeDefined();
    expect(outgoingSynthesizedEdges(httpFinish!.id, 'qt-widgets-connect').some((edge) => edge.target === pageFinish!.id)).toBe(true);
    expect(outgoingSynthesizedEdges(pageFinish!.id, 'qt-widgets-connect').some((edge) => edge.target === widgetFinish!.id)).toBe(true);
    expect(
      graph!
        .getOutgoingEdges(widgetFinish!.id)
        .some((edge) => edge.kind === 'calls' && edge.target === triggerAppCheck!.id)
    ).toBe(true);
  });

  it('links emitted Qt signals when Qt meta declarations are incomplete', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'login.h'),
      `#include <QFrame>
#include <QObject>
#include <QWidget>

class HttpLogin : public QObject {
  Q_OBJECT
public:
  void userLogin();
private slots:
  void slot_userLoginFinish();
signals:
  void signal_userLoginFinish(bool ok, int code, QString desc);
};

class UserNameLoginPage : public QFrame {
  Q_OBJECT
public:
  void initConnections();
  void loginAfterUpdateCheck();
public slots:
  void slot_loginFinished(bool ok, int code, QString desc);
signals:
  void signal_httpLoginFinish(bool ok, int code, QString desc);
};

class LoginWidget : public QWidget {
  Q_OBJECT
public:
  void initConnection();
private slots:
  void slot_userLoginFinish(bool ok, int code, QString desc);
  void slot_triggerAppCheck();
private:
  UserNameLoginPage *loginPage_;
};
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'login.cpp'),
      `#include "login.h"

void HttpLogin::userLogin() {
  connect(this, SIGNAL(signal_userLoginFinish(bool, int, QString)), this, SLOT(slot_userLoginFinish()));
}

void HttpLogin::slot_userLoginFinish() {
  emit signal_userLoginFinish(true, 0, QString());
}

void UserNameLoginPage::initConnections() {
  loginAfterUpdateCheck();
}

void UserNameLoginPage::loginAfterUpdateCheck() {
  HttpLogin *pLoginClient = new HttpLogin;
  connect(pLoginClient, &HttpLogin::signal_userLoginFinish, this, &UserNameLoginPage::slot_loginFinished);
}

void UserNameLoginPage::slot_loginFinished(bool ok, int code, QString desc) {
  emit signal_httpLoginFinish(ok, code, desc);
}

void LoginWidget::initConnection() {
  connect(loginPage_, &UserNameLoginPage::signal_httpLoginFinish, this, &LoginWidget::slot_userLoginFinish);
}

void LoginWidget::slot_userLoginFinish(bool ok, int, QString) {
  if (ok) {
    slot_triggerAppCheck();
  }
}

void LoginWidget::slot_triggerAppCheck() {}
`
    );

    await graph!.indexAll();

    const httpFinish = graph!
      .getNodesByName('slot_userLoginFinish')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('HttpLogin::slot_userLoginFinish'));
    const pageFinish = graph!
      .getNodesByName('slot_loginFinished')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('UserNameLoginPage::slot_loginFinished'));
    const widgetFinish = graph!
      .getNodesByName('slot_userLoginFinish')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('LoginWidget::slot_userLoginFinish'));

    expect(httpFinish).toBeDefined();
    expect(pageFinish).toBeDefined();
    expect(widgetFinish).toBeDefined();
    expect(outgoingSynthesizedEdges(httpFinish!.id, 'qt-widgets-connect').some((edge) => edge.target === pageFinish!.id)).toBe(true);
    expect(outgoingSynthesizedEdges(pageFinish!.id, 'qt-widgets-connect').some((edge) => edge.target === widgetFinish!.id)).toBe(true);
  });

  it('keeps methods after old-style Qt SIGNAL/SLOT macros with typed arguments', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'loginwidget.cpp'),
      `#include <QMainWindow>
#include <QUrl>

class LoginWidget : public QMainWindow {
  Q_OBJECT
public:
  void initConnection();
  void LodingInit();
public slots:
  void slot_anchorClicked(const QUrl&);
  void slot_userLoginFinish(bool, int, QString);
  void slot_triggerAppCheck();
};

void LoginWidget::initConnection() {
  connect(ui.errorTipLab, SIGNAL(anchorClicked(const QUrl&)), this, SLOT(slot_anchorClicked(const QUrl&)));
}

void LoginWidget::LodingInit() {
  movie->start();
}

void LoginWidget::slot_userLoginFinish(bool bSuccess, int, QString) {
  if (bSuccess) {
    slot_triggerAppCheck();
  }
}

void LoginWidget::slot_triggerAppCheck() {}
`
    );

    await graph!.indexAll();

    const lodingInit = graph!
      .getNodesByName('LodingInit')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('LoginWidget::LodingInit'));
    const widgetFinish = graph!
      .getNodesByName('slot_userLoginFinish')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('LoginWidget::slot_userLoginFinish'));
    const triggerAppCheck = graph!
      .getNodesByName('slot_triggerAppCheck')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('LoginWidget::slot_triggerAppCheck'));

    expect(lodingInit).toBeDefined();
    expect(widgetFinish).toBeDefined();
    expect(triggerAppCheck).toBeDefined();
    expect(
      graph!
        .getOutgoingEdges(widgetFinish!.id)
        .some((edge) => edge.kind === 'calls' && edge.target === triggerAppCheck!.id)
    ).toBe(true);
  });

  it('resolves lambda receiver connects to the lambda callback body', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QPushButton>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  void wire(QPushButton *button);
  void updateUi();
};

void MainWindow::wire(QPushButton *button) {
  connect(button, &QPushButton::clicked, this, [this]() {
    updateUi();
  });
}

void MainWindow::updateUi() {}
`
    );

    await graph!.indexAll();

    const wire = graph!
      .getNodesByName('wire')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::wire'));
    const updateUi = graph!
      .getNodesByName('updateUi')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::updateUi'));

    expect(wire).toBeDefined();
    expect(updateUi).toBeDefined();
    expect(outgoingSynthesizedEdges(wire!.id, 'qt-widgets-connect').some((edge) => edge.target === updateUi!.id)).toBe(true);
  });

  it('resolves functor receiver connects to a unique operator call', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QPushButton>

class ClickFunctor {
public:
  void operator()();
};

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  void wire(QPushButton *button);
};

void MainWindow::wire(QPushButton *button) {
  ClickFunctor functor;
  connect(button, &QPushButton::clicked, functor);
}

void ClickFunctor::operator()() {}
`
    );

    await graph!.indexAll();

    const wire = graph!
      .getNodesByName('wire')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::wire'));
    const callOperator = graph!
      .getNodesByName('operator()')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('ClickFunctor::operator()'));

    expect(wire).toBeDefined();
    expect(callOperator).toBeDefined();
    expect(outgoingSynthesizedEdges(wire!.id, 'qt-widgets-connect').some((edge) => edge.target === callOperator!.id)).toBe(true);
  });

  it('resolves .ui auto-connect slots when setupUi is called without explicit connect text', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include "ui_mainwindow.h"

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
private slots:
  void on_okButton_clicked();
};

MainWindow::MainWindow() {
  setupUi(this);
}

void MainWindow::on_okButton_clicked() {}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.ui'),
      `<ui version="4.0">
 <class>MainWindow</class>
 <widget class="QMainWindow" name="MainWindow">
  <widget class="QPushButton" name="okButton" />
 </widget>
</ui>
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const slot = graph!
      .getNodesByName('on_okButton_clicked')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::on_okButton_clicked'));

    expect(constructor).toBeDefined();
    expect(slot).toBeDefined();
    expect(outgoingSynthesizedEdges(constructor!.id, 'qt-widgets-autoconnect').some((edge) => edge.target === slot!.id)).toBe(true);
  });

  it('resolves .ui auto-connect slots through generated ui.setupUi(this) members', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include "ui_mainwindow.h"

namespace Ui { class MainWindow; }

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
private slots:
  void on_tabs_currentChanged();
  void on_results_itemClicked();
  void on_actionRefresh_triggered();
private:
  Ui::MainWindow ui;
};

MainWindow::MainWindow() {
  ui.setupUi(this);
}

void MainWindow::on_tabs_currentChanged() {}
void MainWindow::on_results_itemClicked() {}
void MainWindow::on_actionRefresh_triggered() {}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.ui'),
      `<ui version="4.0">
 <class>MainWindow</class>
 <widget class="QMainWindow" name="MainWindow">
  <widget class="QTabWidget" name="tabs" />
  <widget class="QListWidget" name="results" />
  <action name="actionRefresh" />
 </widget>
</ui>
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const tabs = graph!
      .getNodesByName('on_tabs_currentChanged')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::on_tabs_currentChanged'));
    const results = graph!
      .getNodesByName('on_results_itemClicked')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::on_results_itemClicked'));
    const action = graph!
      .getNodesByName('on_actionRefresh_triggered')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::on_actionRefresh_triggered'));

    expect(constructor).toBeDefined();
    expect(tabs).toBeDefined();
    expect(results).toBeDefined();
    expect(action).toBeDefined();

    const edges = outgoingSynthesizedEdges(constructor!.id, 'qt-widgets-autoconnect');
    expect(edges.some((edge) => edge.target === tabs!.id)).toBe(true);
    expect(edges.some((edge) => edge.target === results!.id)).toBe(true);
    expect(edges.some((edge) => edge.target === action!.id)).toBe(true);
  });

  it('keeps .ui auto-connect limited to widget classes and known Qt signal names', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include "ui_mainwindow.h"

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
private slots:
  void on_okButton_clicked();
  void on_okButton_notASignal();
  void on_gridLayout_clicked();
};

MainWindow::MainWindow() {
  setupUi(this);
}

void MainWindow::on_okButton_clicked() {}
void MainWindow::on_okButton_notASignal() {}
void MainWindow::on_gridLayout_clicked() {}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.ui'),
      `<ui version="4.0">
 <class>MainWindow</class>
 <widget class="QMainWindow" name="MainWindow">
  <layout class="QGridLayout" name="gridLayout" />
  <widget class="QPushButton" name="okButton" />
 </widget>
</ui>
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const clicked = graph!
      .getNodesByName('on_okButton_clicked')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::on_okButton_clicked'));
    const notASignal = graph!
      .getNodesByName('on_okButton_notASignal')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::on_okButton_notASignal'));
    const layoutSlot = graph!
      .getNodesByName('on_gridLayout_clicked')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::on_gridLayout_clicked'));

    expect(constructor).toBeDefined();
    expect(clicked).toBeDefined();
    expect(notASignal).toBeDefined();
    expect(layoutSlot).toBeDefined();

    const autoConnectEdges = outgoingSynthesizedEdges(constructor!.id, 'qt-widgets-autoconnect');
    expect(autoConnectEdges.some((edge) => edge.target === clicked!.id)).toBe(true);
    expect(autoConnectEdges.some((edge) => edge.target === notASignal!.id)).toBe(false);
    expect(autoConnectEdges.some((edge) => edge.target === layoutSlot!.id)).toBe(false);
  });

  it('uses local .ui ownership evidence when duplicate form classes exist', async () => {
    fs.mkdirSync(path.join(tmpDir, 'app'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'other'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'app', 'mainwindow.cpp'),
      `#include <QMainWindow>
#include "ui_mainwindow.h"

namespace App {
class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
private slots:
  void on_appButton_clicked();
  void on_otherButton_clicked();
};
}

App::MainWindow::MainWindow() {
  setupUi(this);
}

void App::MainWindow::on_appButton_clicked() {}
void App::MainWindow::on_otherButton_clicked() {}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'app', 'mainwindow.ui'),
      `<ui version="4.0">
 <class>MainWindow</class>
 <widget class="QMainWindow" name="MainWindow">
  <widget class="QPushButton" name="appButton" />
 </widget>
</ui>
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'other', 'mainwindow.ui'),
      `<ui version="4.0">
 <class>MainWindow</class>
 <widget class="QMainWindow" name="MainWindow">
  <widget class="QPushButton" name="otherButton" />
 </widget>
</ui>
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('App::MainWindow::MainWindow'));
    const appSlot = graph!
      .getNodesByName('on_appButton_clicked')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('App::MainWindow::on_appButton_clicked'));
    const otherSlot = graph!
      .getNodesByName('on_otherButton_clicked')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('App::MainWindow::on_otherButton_clicked'));

    expect(constructor).toBeDefined();
    expect(appSlot).toBeDefined();
    expect(otherSlot).toBeDefined();

    const autoConnectEdges = outgoingSynthesizedEdges(constructor!.id, 'qt-widgets-autoconnect');
    expect(autoConnectEdges.some((edge) => edge.target === appSlot!.id)).toBe(true);
    expect(autoConnectEdges.some((edge) => edge.target === otherSlot!.id)).toBe(false);
  });

  it('does not synthesize edges for pure .ui projects without C++ auto-connect code', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.ui'),
      `<ui version="4.0">
 <class>MainWindow</class>
 <widget class="QMainWindow" name="MainWindow">
  <widget class="QPushButton" name="okButton" />
 </widget>
</ui>
`
    );

    await graph!.indexAll();

    const synthesizedEdges = graph!
      .getNodesByKind('file')
      .flatMap((node) => graph!.getOutgoingEdges(node.id))
      .filter((edge) => edge.metadata && (edge.metadata as Record<string, unknown>).synthesizedBy === 'qt-widgets-autoconnect');
    expect(synthesizedEdges).toHaveLength(0);
  });

  it('updates .ui auto-connect edges when form widgets change during sync', async () => {
    const cppPath = path.join(tmpDir, 'mainwindow.cpp');
    const uiPath = path.join(tmpDir, 'mainwindow.ui');
    fs.writeFileSync(
      cppPath,
      `#include <QMainWindow>
#include "ui_mainwindow.h"

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
private slots:
  void on_okButton_clicked();
  void on_cancelButton_clicked();
};

MainWindow::MainWindow() {
  setupUi(this);
}

void MainWindow::on_okButton_clicked() {}
void MainWindow::on_cancelButton_clicked() {}
`
    );
    fs.writeFileSync(
      uiPath,
      `<ui version="4.0">
 <class>MainWindow</class>
 <widget class="QMainWindow" name="MainWindow">
  <widget class="QPushButton" name="okButton" />
 </widget>
</ui>
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const okSlot = graph!
      .getNodesByName('on_okButton_clicked')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::on_okButton_clicked'));
    const cancelSlot = graph!
      .getNodesByName('on_cancelButton_clicked')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::on_cancelButton_clicked'));

    expect(constructor).toBeDefined();
    expect(okSlot).toBeDefined();
    expect(cancelSlot).toBeDefined();
    expect(outgoingSynthesizedEdges(constructor!.id, 'qt-widgets-autoconnect').some((edge) => edge.target === okSlot!.id)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(
      uiPath,
      `<ui version="4.0">
 <class>MainWindow</class>
 <widget class="QMainWindow" name="MainWindow">
  <widget class="QPushButton" name="cancelButton" />
 </widget>
</ui>
`
    );
    await graph!.sync();

    const autoConnectEdges = outgoingSynthesizedEdges(constructor!.id, 'qt-widgets-autoconnect');
    expect(autoConnectEdges.some((edge) => edge.target === okSlot!.id)).toBe(false);
    expect(autoConnectEdges.some((edge) => edge.target === cancelSlot!.id)).toBe(true);
  });

  it('does not synthesize Qt connect edges when the receiver slot is missing', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QPushButton>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
public slots:
  void existingSlot();
};

MainWindow::MainWindow() {
  auto *button = new QPushButton(this);
  connect(button, &QPushButton::clicked, this, &MainWindow::missingSlot);
}

void MainWindow::existingSlot() {}
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const existingSlot = graph!
      .getNodesByName('existingSlot')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::existingSlot'));

    expect(constructor).toBeDefined();
    expect(existingSlot).toBeDefined();
    expect(
      graph!
        .getOutgoingEdges(constructor!.id)
        .some((edge) => edge.kind === 'calls' && edge.target === existingSlot!.id)
    ).toBe(false);
  });

  it('keeps untyped Qt connects unresolved for overloaded slots', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QComboBox>
#include <QMainWindow>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
public slots:
  void onIndexChanged(int index);
  void onIndexChanged(const QString &text);
};

MainWindow::MainWindow() {
  auto *combo = new QComboBox(this);
  connect(combo, &QComboBox::currentIndexChanged, this, &MainWindow::onIndexChanged);
}

void MainWindow::onIndexChanged(int index) {}
void MainWindow::onIndexChanged(const QString &text) {}
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const slots = graph!
      .getNodesByName('onIndexChanged')
      .filter((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::onIndexChanged'));

    expect(constructor).toBeDefined();
    expect(slots).toHaveLength(2);
    const outgoingCalls = graph!
      .getOutgoingEdges(constructor!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    for (const slot of slots) {
      expect(outgoingCalls).not.toContain(slot.id);
    }
  });

  it('resolves qOverload typed Qt connects to the matching overloaded slot', async () => {
    const mainCpp = path.join(tmpDir, 'mainwindow.cpp');
    fs.writeFileSync(
      mainCpp,
      `#include <QComboBox>
#include <QMainWindow>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
public slots:
  void onIndexChanged(int index);
  void onIndexChanged(const QString &text);
};

MainWindow::MainWindow() {
  auto *combo = new QComboBox(this);
  connect(combo, qOverload<int>(&QComboBox::currentIndexChanged), this, qOverload<int>(&MainWindow::onIndexChanged));
}

void MainWindow::onIndexChanged(int index) {}
void MainWindow::onIndexChanged(const QString &text) {}
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const intSlot = methodNodeIdByLine(graph!, mainCpp, 'onIndexChanged', 'void MainWindow::onIndexChanged(int index)');
    const textSlot = methodNodeIdByLine(graph!, mainCpp, 'onIndexChanged', 'void MainWindow::onIndexChanged(const QString &text)');
    const outgoingCalls = graph!
      .getOutgoingEdges(constructor!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    expect(outgoingCalls).toContain(intSlot);
    expect(outgoingCalls).not.toContain(textSlot);
  });

  it('resolves QOverload typed Qt connects to the matching overloaded slot', async () => {
    const mainCpp = path.join(tmpDir, 'mainwindow.cpp');
    fs.writeFileSync(
      mainCpp,
      `#include <QComboBox>
#include <QMainWindow>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
public slots:
  void onIndexChanged(int index);
  void onIndexChanged(const QString &text);
};

MainWindow::MainWindow() {
  auto *combo = new QComboBox(this);
  QObject::connect(combo, QOverload<const QString &>::of(&QComboBox::currentTextChanged), this, QOverload<const QString &>::of(&MainWindow::onIndexChanged));
}

void MainWindow::onIndexChanged(int index) {}
void MainWindow::onIndexChanged(const QString &text) {}
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const intSlot = methodNodeIdByLine(graph!, mainCpp, 'onIndexChanged', 'void MainWindow::onIndexChanged(int index)');
    const textSlot = methodNodeIdByLine(graph!, mainCpp, 'onIndexChanged', 'void MainWindow::onIndexChanged(const QString &text)');
    const outgoingCalls = graph!
      .getOutgoingEdges(constructor!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    expect(outgoingCalls).not.toContain(intSlot);
    expect(outgoingCalls).toContain(textSlot);
  });

  it('resolves static_cast typed Qt connects to the matching overloaded slot', async () => {
    const mainCpp = path.join(tmpDir, 'mainwindow.cpp');
    fs.writeFileSync(
      mainCpp,
      `#include <QMainWindow>
#include <QSpinBox>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
public slots:
  void onValueChanged(int value);
  void onValueChanged(double value);
};

MainWindow::MainWindow() {
  auto *spin = new QSpinBox(this);
  connect(spin, static_cast<void (QSpinBox::*)(int)>(&QSpinBox::valueChanged), this, static_cast<void (MainWindow::*)(int)>(&MainWindow::onValueChanged));
}

void MainWindow::onValueChanged(int value) {}
void MainWindow::onValueChanged(double value) {}
`
    );

    await graph!.indexAll();

    const constructor = graph!
      .getNodesByName('MainWindow')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const intSlot = methodNodeIdByLine(graph!, mainCpp, 'onValueChanged', 'void MainWindow::onValueChanged(int value)');
    const doubleSlot = methodNodeIdByLine(graph!, mainCpp, 'onValueChanged', 'void MainWindow::onValueChanged(double value)');
    const outgoingCalls = graph!
      .getOutgoingEdges(constructor!.id)
      .filter((edge) => edge.kind === 'calls')
      .map((edge) => edge.target);

    expect(outgoingCalls).toContain(intSlot);
    expect(outgoingCalls).not.toContain(doubleSlot);
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

  it('resolves QTimer singleShot legacy slots to the receiving object method', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QTimer>

class Worker : public QObject {
  Q_OBJECT
public slots:
  void reload();
};

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  void schedule();
private:
  Worker *worker;
};

void MainWindow::schedule() {
  QTimer::singleShot(100, worker, SLOT(reload()));
}

void Worker::reload() {}
`
    );

    await graph!.indexAll();

    const schedule = graph!
      .getNodesByName('schedule')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::schedule'));
    const reload = graph!
      .getNodesByName('reload')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('Worker::reload'));

    expect(schedule).toBeDefined();
    expect(reload).toBeDefined();
    expect(outgoingSynthesizedEdges(schedule!.id, 'qt-widgets-connect').some((edge) => edge.target === reload!.id)).toBe(true);
  });

  it('resolves QMetaObject invokeMethod string targets conservatively', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QMetaObject>

class Worker : public QObject {
  Q_OBJECT
public slots:
  void reload();
};

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  void invoke();
private:
  Worker *worker;
};

void MainWindow::invoke() {
  QMetaObject::invokeMethod(worker, "reload");
}

void Worker::reload() {}
`
    );

    await graph!.indexAll();

    const invoke = graph!
      .getNodesByName('invoke')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::invoke'));
    const reload = graph!
      .getNodesByName('reload')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('Worker::reload'));

    expect(invoke).toBeDefined();
    expect(reload).toBeDefined();
    expect(outgoingSynthesizedEdges(invoke!.id, 'qt-widgets-connect').some((edge) => edge.target === reload!.id)).toBe(true);
  });

  it('resolves QTimer singleShot lambda callbacks to owner methods', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QTimer>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  void schedule();
  void refresh();
};

void MainWindow::schedule() {
  QTimer::singleShot(100, this, [this]() {
    refresh();
  });
}

void MainWindow::refresh() {}
`
    );

    await graph!.indexAll();

    const schedule = graph!
      .getNodesByName('schedule')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::schedule'));
    const refresh = graph!
      .getNodesByName('refresh')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::refresh'));

    expect(schedule).toBeDefined();
    expect(refresh).toBeDefined();
    expect(outgoingSynthesizedEdges(schedule!.id, 'qt-widgets-connect').some((edge) => edge.target === refresh!.id)).toBe(true);
  });

  it('resolves QMetaObject invokeMethod typed member-pointer targets', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QCoreApplication>
#include <QMainWindow>
#include <QMetaObject>

class AppController : public QObject {
  Q_OBJECT
public slots:
  void quit();
};

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  void invoke(AppController *app);
};

void MainWindow::invoke(AppController *app) {
  QMetaObject::invokeMethod(app, &AppController::quit);
}

void AppController::quit() {}
`
    );

    await graph!.indexAll();

    const invoke = graph!
      .getNodesByName('invoke')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::invoke'));
    const quit = graph!
      .getNodesByName('quit')
      .find((node) => node.kind === 'method' && node.qualifiedName.endsWith('AppController::quit'));

    expect(invoke).toBeDefined();
    expect(quit).toBeDefined();
    expect(outgoingSynthesizedEdges(invoke!.id, 'qt-widgets-connect').some((edge) => edge.target === quit!.id)).toBe(true);
  });
});
