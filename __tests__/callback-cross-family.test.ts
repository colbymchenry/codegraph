import { it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

// Reduced from Excalidraw App.tsx -> element/src/Scene.ts: the field receiver
// crosses TSX/TS, then the observer edge must return to the registering class.
it.each(['tsx', 'jsx'])('resolves %s -> TS field calls before synthesizing the callback', async (ext) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-callback-family-'));
  let cg: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'scene.ts'), `export class Scene {
      private callbacks = new Set<Function>();
      onUpdate(cb: Function) { this.callbacks.add(cb); }
      triggerUpdate() { for (const callback of Array.from(this.callbacks)) { callback(); } }
    }`);
    fs.writeFileSync(path.join(root, 'a_decoy.ts'), 'export class Decoy { triggerRender() {} }');
    fs.writeFileSync(path.join(root, `app.${ext}`), `import { Scene } from './scene';
      export class App {
        ${ext === 'tsx' ? 'public scene: Scene;' : 'scene = new Scene();'}
        componentDidMount() { this.scene.onUpdate(this.triggerRender); }
        triggerRender = () => {};
      }`);
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const registrar = cg.getNodesByName('onUpdate')[0];
    expect(cg.getCallers(registrar.id).some(x => x.node.qualifiedName === 'App::componentDidMount')).toBe(true);
    const dispatcher = cg.getNodesByName('triggerUpdate')[0];
    const callbacks = cg.getCallees(dispatcher.id).filter(x => x.edge.metadata?.synthesizedBy === 'callback');
    expect(callbacks.map(x => x.node.qualifiedName)).toEqual(['App::triggerRender']);
  } finally {
    cg?.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
