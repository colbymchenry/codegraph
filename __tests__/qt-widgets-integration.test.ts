import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';

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
});
