/**
 * Regression: codegraph_explore's "Dynamic-dispatch links among your symbols"
 * section lists each synthesized LINK, not each pair of names.
 *
 * It used to dedupe its lines by `source name > target name`. Every
 * `interface → impl` link of one interface method reads `area → area`, so an
 * interface method with several implementations printed ONE line, and which
 * implementation survived was decided by edge order, not by the query: naming
 * `Square.area` showed Triangle's link and hid Square's (gin's
 * `setter.TrySet`, prometheus's `Queryable.Querier`). Links are now keyed by
 * their endpoints, and a hop already on the rendered Flow chain is still left
 * out. When more links exist than the 6-line cap holds, links into test files
 * through an end the query didn't name go last, and the rest go by how
 * pointedly the query named their ends, so the cap never drops an
 * implementation the query names for one it doesn't.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

// Assertions read RAW codegraph_explore output; managed offload would replace it.
let prevOffloadDisable: string | undefined;
beforeAll(() => {
  prevOffloadDisable = process.env.CODEGRAPH_OFFLOAD_DISABLE;
  process.env.CODEGRAPH_OFFLOAD_DISABLE = '1';
});
afterAll(() => {
  if (prevOffloadDisable === undefined) delete process.env.CODEGRAPH_OFFLOAD_DISABLE;
  else process.env.CODEGRAPH_OFFLOAD_DISABLE = prevOffloadDisable;
});

const SECTION = '**Dynamic-dispatch links among your symbols**';

/** The `- a → b [...]` lines of the dynamic-dispatch links section. */
function linkLines(text: string): string[] {
  const at = text.indexOf(SECTION);
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of text.slice(at + SECTION.length).split(/\r?\n/)) {
    if (line.startsWith('- ')) out.push(line);
    else if (out.length > 0) break;
  }
  return out;
}

/** The rendered Flow section, up to the next section header. */
function flowSection(text: string): string {
  const at = text.indexOf('**Flow (call path');
  if (at < 0) return '';
  const end = text.indexOf(SECTION, at);
  return text.slice(at, end < 0 ? undefined : end);
}

describe('codegraph_explore — dynamic-dispatch links are listed per link', () => {
  let dir = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  /**
   * `Shape.area` with one implementation per name. `Circle.area` calls
   * `scale`, so `report → Shape.area → Circle.area → scale` is the longest
   * chain among the query's symbols and the Flow section runs through Circle,
   * never through the implementation the query names. `testDoubles` go in
   * `fakes/<name>.test.ts`.
   */
  async function indexShapes(implementations: string[], testDoubles: string[] = []): Promise<ToolHandler> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-synth-links-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('shape.ts', 'export interface Shape {\n  area(): number;\n}\n');
    write('scale.ts', 'export function scale(n: number): number {\n  return n * 2;\n}\n');
    write(
      'report.ts',
      "import type { Shape } from './shape';\n\nexport function report(shape: Shape): number {\n  return shape.area();\n}\n"
    );
    write(
      'circle.ts',
      "import type { Shape } from './shape';\nimport { scale } from './scale';\n\nexport class Circle implements Shape {\n  area(): number {\n    return scale(3);\n  }\n}\n"
    );
    for (const name of implementations) {
      write(
        `${name.toLowerCase()}.ts`,
        `import type { Shape } from './shape';\n\nexport class ${name} implements Shape {\n  area(): number {\n    return 1;\n  }\n}\n`
      );
    }
    for (const name of testDoubles) {
      write(
        `fakes/${name.toLowerCase()}.test.ts`,
        `import type { Shape } from '../shape';\n\nexport class ${name} implements Shape {\n  area(): number {\n    return 0;\n  }\n}\n`
      );
    }
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    return new ToolHandler(cg);
  }

  /** `Shape.area`'s interface → impl links, in the order the graph returns them. */
  function implementationsInEdgeOrder(): string[] {
    const iface = cg!.getNodesByName('area').find((n) => n.qualifiedName === 'Shape::area');
    expect(iface).toBeDefined();
    return cg!
      .getOutgoingEdges(iface!.id)
      .filter((e) => e.provenance === 'heuristic' && e.metadata?.synthesizedBy === 'interface-impl')
      .map((e) => cg!.getNode(e.target)?.qualifiedName.split('::')[0] ?? '');
  }

  it('lists the named implementation and every other off-chain one, the named one first', async () => {
    const handler = await indexShapes(['Square', 'Triangle']);
    expect(implementationsInEdgeOrder().sort()).toEqual(['Circle', 'Square', 'Triangle']);

    const res = await handler.execute('codegraph_explore', { query: 'report Shape.area Square.area scale' });
    const text = res.content[0].text as string;

    // Precondition: the Flow runs through Circle, so Square's link is not on it.
    const flow = flowSection(text);
    expect(flow).toMatch(/\d\. area \(circle\.ts:\d+\)/);
    expect(flow).not.toContain('square.ts');

    const links = linkLines(text);
    const square = links.findIndex((l) => l.includes('@square.ts:'));
    const triangle = links.findIndex((l) => l.includes('@triangle.ts:'));
    // Distinct implementations are distinct links — the name pair `area → area`
    // no longer folds them into one line.
    expect(square).toBeGreaterThanOrEqual(0);
    expect(triangle).toBeGreaterThanOrEqual(0);
    // The implementation the query named leads.
    expect(square).toBeLessThan(triangle);
    // `area → area` names neither side; each end is named by its owner.
    expect(links[square]).toMatch(/^- Shape\.area → Square\.area\s+\[dynamic: interface → impl @square\.ts:4\]$/);
    expect(links[triangle]).toMatch(/^- Shape\.area → Triangle\.area\s+\[dynamic: interface → impl @triangle\.ts:4\]$/);
    // The chain's own hop is rendered in the Flow, not repeated here.
    expect(links.some((l) => l.includes('circle.ts'))).toBe(false);
    expect(links).toHaveLength(2);
  }, 120_000);

  it('keeps the 6-line cap and spends its first line on the named implementation', async () => {
    const others = ['Square', 'Triangle', 'Pentagon', 'Hexagon', 'Heptagon', 'Octagon', 'Nonagon', 'Decagon'];
    const handler = await indexShapes(others);
    // Name the implementation edge order would list LAST, so only the
    // named-first rule can bring it under the cap.
    const order = implementationsInEdgeOrder().filter((owner) => owner !== 'Circle');
    expect([...order].sort()).toEqual([...others].sort());
    const last = order[order.length - 1]!;

    const res = await handler.execute('codegraph_explore', { query: `report Shape.area ${last}.area scale` });
    const text = res.content[0].text as string;
    expect(flowSection(text)).toMatch(/\d\. area \(circle\.ts:\d+\)/);

    const links = linkLines(text);
    expect(links).toHaveLength(6);
    expect(links[0]).toMatch(new RegExp(`^- Shape\\.area → ${last}\\.area\\s+\\[dynamic: interface → impl @${last.toLowerCase()}\\.ts:4\\]$`));
    // The other five are five distinct implementations, none of them the chain's.
    const rest = links.slice(1).map((l) => /→ (\w+)\.area/.exec(l)?.[1]);
    expect(new Set(rest).size).toBe(5);
    for (const owner of rest) expect(order).toContain(owner);
    expect(rest).not.toContain(last);
    expect(links.some((l) => l.includes('circle.ts'))).toBe(false);
  }, 120_000);

  it('lists links into test files after the rest when the cap forces a choice', async () => {
    // prometheus's `Queryable.Querier` has about as many test doubles as real
    // implementations. Explore's answer leaves test files out, and here they only
    // get the lines the real implementations leave.
    const production = ['Square', 'Triangle', 'Pentagon', 'Hexagon', 'Heptagon', 'Octagon'];
    const doubles = ['FakeA', 'FakeB', 'FakeC', 'FakeD', 'FakeE', 'FakeF'];
    const handler = await indexShapes(production, doubles);
    // Precondition: in edge order, a test double would take one of the six lines.
    const order = implementationsInEdgeOrder().filter((owner) => owner !== 'Circle');
    expect([...order].sort()).toEqual([...production, ...doubles].sort());
    expect(order.slice(0, 6).some((owner) => doubles.includes(owner))).toBe(true);

    const res = await handler.execute('codegraph_explore', { query: 'report Shape.area scale' });
    const text = res.content[0].text as string;
    expect(flowSection(text)).toMatch(/\d\. area \(circle\.ts:\d+\)/);
    const links = linkLines(text);
    expect(links).toHaveLength(6);
    expect(links.map((l) => /→ (\w+)\.area/.exec(l)?.[1]).sort()).toEqual([...production].sort());
  }, 120_000);

  it("puts the links of an interface the query picks out before links among an ambiguous name's candidates", async () => {
    // prometheus's `Discovery.refresh` matches a `Discovery` type in each discovery
    // package. In `Discovery.refresh fetchApps Decoder.Decode`, their links to each
    // other filled the cap and hid the one link into `fetchApps`, which the query
    // names exactly.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-synth-links-ambiguous-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('iface.ts', 'export interface Discovery {\n  refresh(): number;\n}\n');
    for (let i = 1; i <= 5; i++) {
      write(
        `pkg${i}/discovery.ts`,
        `import type { Discovery as Base } from '../iface';\n\nexport class Discovery implements Base {\n  refresh(): number {\n    return ${i};\n  }\n}\n`
      );
    }
    write('refresher.ts', 'export interface Refresher {\n  refresh(): number;\n}\n');
    for (const name of ['Hcloud', 'Robot']) {
      write(
        `${name.toLowerCase()}.ts`,
        `import type { Refresher } from './refresher';\n\nexport class ${name} implements Refresher {\n  refresh(): number {\n    return 0;\n  }\n}\n`
      );
    }
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    // Precondition: the interface `Discovery` links to all five classes of its name.
    const discoveryLinks = cg
      .getNodesByName('refresh')
      .filter((n) => n.qualifiedName === 'Discovery::refresh')
      .flatMap((n) => cg!.getOutgoingEdges(n.id).filter((e) => e.metadata?.synthesizedBy === 'interface-impl'));
    expect(discoveryLinks).toHaveLength(5);

    const res = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'Discovery.refresh Refresher.refresh Hcloud.refresh',
    });
    const links = linkLines(res.content[0].text as string);
    expect(links).toHaveLength(6);
    expect(links[0]).toBe('- Refresher.refresh → Hcloud.refresh   [dynamic: interface → impl @hcloud.ts:4]');
    expect(links[1]).toBe('- Refresher.refresh → Robot.refresh   [dynamic: interface → impl @robot.ts:4]');
    for (const l of links.slice(2)) {
      expect(l).toMatch(/^- Discovery\.refresh → Discovery\.refresh {3}\[dynamic: interface → impl @pkg\d\/discovery\.ts:4\]$/);
    }
  }, 120_000);

  it('lets the named symbols take turns, so one long fan-out does not fill the list', async () => {
    // prometheus's `refresh.Discovery.refresh` hands its func field to 28
    // discovery packages, and in a query that also names hetzner's
    // `refresher.refresh` those links filled the list before robotDiscovery's.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-synth-links-turns-'));
    const write = (rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content);
    const family = (iface: string, classes: string[]) => {
      write(`${iface.toLowerCase()}.ts`, `export interface ${iface} {\n  run(): number;\n}\n`);
      for (const name of classes) {
        write(
          `${name.toLowerCase()}.ts`,
          `import type { ${iface} } from './${iface.toLowerCase()}';\n\nexport class ${name} implements ${iface} {\n  run(): number {\n    return 1;\n  }\n}\n`
        );
      }
    };
    family('Wide', ['WideA', 'WideB', 'WideC', 'WideD', 'WideE', 'WideF', 'WideG', 'WideH']);
    family('Narrow', ['NarrowA', 'NarrowB']);
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'Wide.run Narrow.run' });
    const links = linkLines(res.content[0].text as string);
    expect(links).toHaveLength(6);
    // Both of Narrow's links make the list, taking turns with Wide's.
    expect(links.map((l) => /^- (\w+)\.run →/.exec(l)?.[1])).toEqual(['Wide', 'Narrow', 'Wide', 'Narrow', 'Wide', 'Wide']);
    expect(links.filter((l) => l.startsWith('- Narrow.run → ')).map((l) => /→ (\w+)\.run/.exec(l)?.[1]).sort()).toEqual(['NarrowA', 'NarrowB']);
  }, 120_000);

  it('prints two links that read the same once, and none that reads like a Flow hop', async () => {
    // gin declares `Binding` once per build tag (binding.go, binding_nomsgpack.go),
    // so formBinding.Bind is linked from two `Binding.Bind` nodes and both links
    // print as the same line.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-synth-links-go-'));
    const write = (rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content);
    write('go.mod', 'module example.com/binding\n\ngo 1.22\n');
    const iface = 'package binding\n\ntype Binding interface {\n\tBind(req string) error\n}\n';
    write('binding.go', `//go:build !nomsgpack\n\n${iface}`);
    write('binding_nomsgpack.go', `//go:build nomsgpack\n\n${iface}`);
    write(
      'form.go',
      'package binding\n\ntype formBinding struct{}\n\nfunc (b formBinding) Bind(req string) error {\n\treturn mapForm(req)\n}\n\nfunc mapForm(req string) error {\n\treturn nil\n}\n'
    );
    write(
      'query.go',
      'package binding\n\ntype queryBinding struct{}\n\nfunc (b queryBinding) Bind(req string) error {\n\treturn mapForm(req)\n}\n'
    );
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.go'], exclude: [] } });
    await cg.indexAll();

    // Precondition: each declaration links to both implementations.
    const declarations = cg.getNodesByName('Bind').filter((n) => n.qualifiedName === 'Binding::Bind');
    expect(declarations).toHaveLength(2);
    for (const d of declarations) {
      const targets = cg
        .getOutgoingEdges(d.id)
        .filter((e) => e.metadata?.synthesizedBy === 'interface-impl')
        .map((e) => cg!.getNode(e.target)?.qualifiedName);
      expect(targets.sort()).toEqual(['formBinding::Bind', 'queryBinding::Bind']);
    }

    const handler = new ToolHandler(cg);
    // Two symbols make no Flow: each implementation's link, once.
    const pair = await handler.execute('codegraph_explore', { query: 'Binding.Bind formBinding.Bind' });
    expect(linkLines(pair.content[0].text as string)).toEqual([
      '- Binding.Bind → formBinding.Bind   [dynamic: interface → impl @form.go:5]',
      '- Binding.Bind → queryBinding.Bind   [dynamic: interface → impl @query.go:5]',
    ]);

    // The Flow runs through one declaration's link to formBinding.Bind. The other
    // declaration's link reads exactly like that hop, so it is not listed under it.
    const res = await handler.execute('codegraph_explore', { query: 'Binding.Bind formBinding.Bind mapForm' });
    const text = res.content[0].text as string;
    expect(flowSection(text)).toMatch(/\d\. Bind \(binding(_nomsgpack)?\.go:\d+\)\n\s+↓ dynamic: interface → impl @form\.go:5\n\d\. Bind \(form\.go:5\)/);
    expect(linkLines(text)).toEqual([
      '- Binding.Bind → queryBinding.Bind   [dynamic: interface → impl @query.go:5]',
    ]);
  }, 120_000);
});
