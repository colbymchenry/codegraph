/**
 * Slint extraction tests.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import {
  detectLanguage,
  getSupportedLanguages,
  initGrammars,
  isLanguageSupported,
  isSourceFile,
  loadGrammarsForLanguages,
} from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['slint']);
});

describe('Slint Extraction', () => {
  describe('Language detection', () => {
    it('should detect Slint files', () => {
      expect(detectLanguage('ui/main.slint')).toBe('slint');
      expect(isSourceFile('ui/main.slint')).toBe(true);
    });

    it('should report Slint as supported', () => {
      expect(isLanguageSupported('slint')).toBe(true);
      expect(getSupportedLanguages()).toContain('slint');
    });
  });

  it('extracts components, globals, interfaces, structs, enums, members, and imports', () => {
    const code = `
import { Button, VerticalBox } from "std-widgets.slint";

export struct Person {
    name: string,
    age: int,
}

export enum Mode {
    Light,
    Dark,
}

global AppState {
    in-out property <int> counter: 0;
    callback increment(int);

    public function bump(delta: int) -> int {
        counter += delta;
        return counter;
    }
}

export interface Greeter {
    callback greet(string) -> string;
    function reset();
}

export component MainWindow inherits Window implements Greeter {
    in property <string> title: "Demo";
    out property <int> doubled: AppState.counter * 2;
    callback accepted(string);

    function handle-click(name: string) {
        AppState.bump(1);
        accepted(name);
    }

    VerticalBox {
        Button {
            text: title;
            clicked => {
                root.handle-click("world");
            }
        }
    }
}
`;
    const result = extractFromSource('ui/main.slint', code);
    const byName = new Map(result.nodes.map((n) => [`${n.kind}:${n.name}`, n]));

    expect(byName.get('import:std-widgets.slint')?.signature).toContain('Button');
    expect(byName.get('struct:Person')?.isExported).toBe(true);
    expect(byName.get('field:name')?.qualifiedName).toBe('Person::name');
    expect(byName.get('enum:Mode')?.isExported).toBe(true);
    expect(byName.get('enum_member:Light')?.qualifiedName).toBe('Mode::Light');
    expect(byName.get('class:AppState')?.language).toBe('slint');
    expect(byName.get('property:counter')?.qualifiedName).toBe('AppState::counter');
    expect(byName.get('method:bump')?.signature).toBe('(delta: int) -> int');
    expect(byName.get('interface:Greeter')?.isExported).toBe(true);
    expect(byName.get('method:greet')?.qualifiedName).toBe('Greeter::greet');
    expect(byName.get('component:MainWindow')?.isExported).toBe(true);
    expect(byName.get('property:title')?.qualifiedName).toBe('MainWindow::title');
    expect(byName.get('method:handle-click')?.qualifiedName).toBe('MainWindow::handle-click');
  });

  it('records Slint inheritance, implemented interfaces, child components, and calls', () => {
    const code = `
interface Greeter {
    callback greet(string);
}

export component MainWindow inherits Window implements Greeter {
    callback accepted(string);

    function handle-click(name: string) {
        accepted(name);
    }

    Button {
        clicked => {
            root.handle-click("world");
        }
    }
}
`;
    const result = extractFromSource('ui/main.slint', code);
    const main = result.nodes.find((n) => n.kind === 'component' && n.name === 'MainWindow');
    const handler = result.nodes.find((n) => n.kind === 'method' && n.name === 'handle-click');
    expect(main).toBeDefined();
    expect(handler).toBeDefined();

    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromNodeId: main?.id, referenceKind: 'extends', referenceName: 'Window' }),
        expect.objectContaining({ fromNodeId: main?.id, referenceKind: 'implements', referenceName: 'Greeter' }),
        expect.objectContaining({ fromNodeId: main?.id, referenceKind: 'references', referenceName: 'Button' }),
        expect.objectContaining({ fromNodeId: main?.id, referenceKind: 'calls', referenceName: 'handle-click' }),
        expect.objectContaining({ fromNodeId: handler?.id, referenceKind: 'calls', referenceName: 'accepted' }),
      ])
    );
  });

  it('records Slint re-export barrels as import dependencies', () => {
    const code = `
export { AboutPage } from "about_page.slint";
export { TableViewPage, TableViewPageAdapter } from "table_view_page.slint";
`;
    const result = extractFromSource('ui/pages/pages.slint', code);
    const file = result.nodes.find((n) => n.kind === 'file' && n.name === 'pages.slint');
    expect(file).toBeDefined();

    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'import',
          name: 'about_page.slint',
          signature: 'export { AboutPage } from "about_page.slint";',
        }),
        expect.objectContaining({
          kind: 'import',
          name: 'table_view_page.slint',
          signature: 'export { TableViewPage, TableViewPageAdapter } from "table_view_page.slint";',
        }),
      ])
    );
    expect(result.unresolvedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromNodeId: file?.id, referenceKind: 'imports', referenceName: 'AboutPage' }),
        expect.objectContaining({ fromNodeId: file?.id, referenceKind: 'imports', referenceName: 'TableViewPage' }),
        expect.objectContaining({ fromNodeId: file?.id, referenceKind: 'imports', referenceName: 'TableViewPageAdapter' }),
      ])
    );
  });
});
