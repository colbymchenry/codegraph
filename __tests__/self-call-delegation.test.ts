/**
 * A method that hands its call on to another object — a wrapper — is not
 * calling itself. TS/JS calls through `this.<field>…` or `window.<x>…` reach
 * the resolver by their bare name, so BookStack's `toggle()` doing
 * `this.container.classList.toggle('open')` and `listen()` doing
 * `window.$events.listen(…)` bound to themselves; a guess from a receiver's
 * name alone (`FileStorage::delete` doing `$storage->delete($path)`) did too.
 * A recursion through a field the class declares as its own type stays.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-self-call-'));
  const files: Record<string, string> = {
    'resources/js/editor-toolbox.ts': `export class EditorToolbox {
  container: HTMLElement;

  toggle(): void {
    this.container.classList.toggle('open');
    this.toggle();
  }
}
`,
    'resources/js/tree.ts': `export class TreeNode {
  left: TreeNode | null = null;

  insert(v: number): void {
    this.left.insert(v);
  }
}
`,
    'resources/js/common-events.js': `export function listen(editor) {
  window.$events.listen('editor::replace', () => editor.reset());
}
`,
    'app/Uploads/FileStorage.php': `<?php

class FileStorage
{
    public function delete(string $path): void
    {
        $storage = $this->getStorageDisk();
        $storage->delete($path);
    }

    protected function getStorageDisk()
    {
        return null;
    }
}
`,
    'app/Uploads/ImageStorage.php': `<?php

class ImageStorage
{
    public function delete(string $path): void
    {
    }
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const selfCallLines = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls' && e.source === e.target).map((e) => e.line);
};

describe('a call a method hands on', () => {
  it('through a field of another type is not the method itself', () => {
    expect(selfCallLines('resources/js/editor-toolbox.ts')).toEqual([6]);
    expect(selfCallLines('resources/js/common-events.js')).toEqual([]);
  });

  it('through a field of the class’s own type is a recursion', () => {
    expect(selfCallLines('resources/js/tree.ts')).toEqual([5]);
  });

  it('through a receiver named like the caller’s class is not the method itself', () => {
    expect(selfCallLines('app/Uploads/FileStorage.php')).toEqual([]);
  });
});
