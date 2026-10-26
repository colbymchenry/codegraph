/**
 * A method that hands its call on to another object — a wrapper — is not
 * calling itself. Calls through `this.<field>…` / `window.<x>…` (TS/JS) or
 * through an expression's value (Scala `requestToArmeria(request).execute()`,
 * Rust `self.0.into_route(state)`) reach the resolver by their bare name, so
 * BookStack's `toggle()` doing `this.container.classList.toggle('open')`
 * bound to itself; a guess from a receiver's name alone (`FileStorage::delete`
 * doing `$storage->delete($path)`) did too, and a value's initializer chain
 * (`val response = basicRequest.get(…).response(…)`) to the value. A recursion
 * through a field the class declares as its own type stays.
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
    'core/src/main/scala/sttp/ArmeriaBackend.scala': `package sttp

class ArmeriaBackend {
  def requestToArmeria(request: String): Client = new Client

  def execute(request: String): Unit = {
    val armeriaRes = requestToArmeria(request).execute()
  }
}

class CurlTest {
  val response = basicRequest
    .get("http://example.com")
    .response(asString)
}
`,
    'src/routing/route.rs': `pub struct BoxedIntoRoute(Box<dyn ErasedIntoRoute>);

impl BoxedIntoRoute {
    pub fn into_route(self, state: u32) -> u32 {
        self.0.into_route(state)
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

  it('through another expression’s value is not the method itself', () => {
    expect(selfCallLines('core/src/main/scala/sttp/ArmeriaBackend.scala')).toEqual([]);
    expect(selfCallLines('src/routing/route.rs')).toEqual([]);
  });

  it('through a receiver named like the caller’s class is not the method itself', () => {
    expect(selfCallLines('app/Uploads/FileStorage.php')).toEqual([]);
  });
});
