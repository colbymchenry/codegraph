/**
 * The default-export namespace object — `const UploadApi = { uploadARCapture };
 * export default UploadApi` — and a call through it from another file. Two
 * things have to hold for `handleZipComplete → uploadARCapture` to exist:
 * the default import must find the constant the `export default` statement
 * names (it is not exported at its declaration), and the member must resolve
 * to the binding the shorthand property carries, through the object's own
 * imports.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('namespace object default exports', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-namespace-object-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it('resolves Api.member() to the function the shorthand property names', async () => {
    write('package.json', '{"name":"app"}');
    write('src/api/frames.ts', 'export async function uploadARCapture(uri: string) {\n  return uri\n}\n');
    write('src/api/folders.ts', 'export function createFolder(name: string) {\n  return name\n}\n');
    write(
      'src/api/index.ts',
      "import { uploadARCapture } from './frames'\n" +
        "import { createFolder } from './folders'\n" +
        'function localHelper() {\n  return 1\n}\n' +
        'const UploadApi = {\n  uploadARCapture,\n  makeFolder: createFolder,\n  localHelper,\n}\n' +
        'export default UploadApi\n'
    );
    write(
      'src/hooks.ts',
      "import UploadApi from './api'\n" +
        'export function handleZipComplete(uri: string) {\n' +
        '  UploadApi.makeFolder(uri)\n' +
        '  UploadApi.localHelper()\n' +
        '  return UploadApi.uploadARCapture(uri)\n' +
        '}\n'
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const handler = cg.getNodesByName('handleZipComplete')[0]!;
    const callees = cg.getCallees(handler.id).map((c) => c.node.name).sort();
    cg.close();
    expect(callees).toEqual(['createFolder', 'localHelper', 'uploadARCapture']);
  });

  it('a default import of a later-exported const finds that const, and a method inside it', async () => {
    write('package.json', '{"name":"app"}');
    write(
      'src/store.ts',
      'const useStore = {\n  read() {\n    return 1\n  },\n}\nexport function unrelated() {\n  return 2\n}\nexport default useStore\n'
    );
    write('src/use.ts', "import store from './store'\nexport function consume() {\n  return store.read()\n}\n");
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const consume = cg.getNodesByName('consume')[0]!;
    const callees = cg.getCallees(consume.id).map((c) => c.node.name);
    cg.close();
    // Without the `export default NAME` binding the default import guessed the
    // first exported function (`unrelated`); now it is the object, and the
    // member resolves inside it.
    expect(callees).toEqual(['read']);
  });
});
