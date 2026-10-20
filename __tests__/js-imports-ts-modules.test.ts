/**
 * A JavaScript file importing a TypeScript module without an extension —
 * `import AudioModal from './audio_modal'` in mastodon's `modal_root.jsx`,
 * with `audio_modal.tsx` beside it — names that module, as it does for the
 * bundler and for TypeScript with `allowJs`. The import resolver tried only
 * JavaScript extensions for a `.js` or `.jsx` importer, so a codebase halfway
 * through moving to TypeScript had none of those imports followed: they were
 * matched by name, which links nothing when the local name differs from the
 * export and picks a namesake when the name repeats.
 *
 * A JavaScript module still comes first: next to `helpers.js`, a `helpers.ts`
 * doesn't take its importers.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-imports-ts-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

/** `<kind> <target file>:<target qualified name> by <resolver>` for the import and call edges leaving `file`. */
function edgesFrom(cg: CodeGraph, file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return [...new Set(cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'imports' || e.kind === 'calls')
    .map((e) => {
      const target = cg.getNode(e.target);
      return `${e.kind} ${target?.filePath}:${target?.qualifiedName} by ${String(e.metadata?.resolvedBy ?? e.metadata?.synthesizedBy)}`;
    }))]
    .filter((e) => !e.includes(`${file}:`))
    .sort();
}

describe('a JavaScript file importing a TypeScript module', () => {
  it('links the module the import names, without an extension', async () => {
    const cg = await indexProject({
      'package.json': JSON.stringify({ name: 'social', dependencies: { react: '^18.2.0' } }),
      // The TypeScript modules the JavaScript files import.
      'app/features/ui/components/audio_modal.tsx': `export default function AudioModal(props: { src: string }) {
  return <audio src={props.src} />;
}
`,
      'app/utils/time.ts': `export function formatTime(seconds: number): string {
  return String(seconds);
}
`,
      'app/store/index.ts': `export function configureStore(): object {
  return {};
}
`,
      // A namesake that name matching would have to choose between.
      'app/features/video/time.ts': `export function formatTime(seconds: number): string {
  return seconds.toFixed(1);
}
`,
      'app/features/ui/components/modal_root.jsx': `import Modal from './audio_modal';
import { formatTime } from '../../../utils/time';

export function ModalRoot(props) {
  return <Modal src={formatTime(props.seconds)} />;
}
`,
      'app/main.js': `import { configureStore } from './store';

export function start() {
  return configureStore();
}
`,
    });
    try {
      expect({
        modalRoot: edgesFrom(cg, 'app/features/ui/components/modal_root.jsx'),
        main: edgesFrom(cg, 'app/main.js'),
      }).toEqual({
        // The default import links its module, and the tag renders what it exports.
        modalRoot: [
          'calls app/features/ui/components/audio_modal.tsx:AudioModal by jsx-render',
          'calls app/utils/time.ts:formatTime by import',
          'imports app/features/ui/components/audio_modal.tsx:app/features/ui/components/audio_modal.tsx by import',
          'imports app/utils/time.ts:app/utils/time.ts by import',
          'imports app/utils/time.ts:formatTime by import',
        ],
        main: [
          'calls app/store/index.ts:configureStore by import',
          'imports app/store/index.ts:app/store/index.ts by import',
          'imports app/store/index.ts:configureStore by import',
        ],
      });
    } finally {
      cg.close();
    }
  }, 60_000);

  it('still links the JavaScript module when both exist', async () => {
    const cg = await indexProject({
      'package.json': JSON.stringify({ name: 'tools' }),
      'lib/helpers.js': `export function slugify(text) {
  return text.toLowerCase();
}
`,
      'lib/helpers.ts': `export function slugify(text: string): string {
  return text.toLowerCase();
}
`,
      'lib/index.js': `import { slugify } from './helpers';

export function title(text) {
  return slugify(text);
}
`,
    });
    try {
      expect(edgesFrom(cg, 'lib/index.js')).toEqual([
        'calls lib/helpers.js:slugify by import',
        'imports lib/helpers.js:lib/helpers.js by import',
        'imports lib/helpers.js:slugify by import',
      ]);
    } finally {
      cg.close();
    }
  }, 60_000);
});
