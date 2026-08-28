/**
 * codegraph_explore — NL-stopword collision guard (named-symbol seeding).
 *
 * handleExplore's named-symbol seeding treats every identifier-shaped query
 * token as "a symbol the agent named" and grants its definition the
 * named-FIRST sort tier. But explore also takes natural-language questions,
 * whose ordinary English words collide with real callables: on this repo the
 * query "…check the latest version…" exact-matched the lone `check()` method
 * of an unrelated WAL-valve class, which then outranked (and, within the
 * per-repo file budget, fully displaced) the upgrade module the corroboration
 * ranking had correctly scored — so the agent fell back to Read/Grep.
 *
 * The guard: a shape-precise token (camelCase, PascalCase, snake_case,
 * qualified) seeds unconditionally — it is an unambiguous symbol reference.
 * A BARE lowercase word seeds only definitions whose file another query token
 * co-names (that other token is itself a symbol defined in the same file, the
 * "check drain fire" sibling-bag shape) — which an incidental English-word
 * collision never is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

/** Paths explore rendered as full-body ``**`<path>`** —`` source sections, in order. */
function sourcedFiles(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\*\*`(.+?)`\*\* —/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

describe('codegraph_explore — NL-stopword collision guard', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stopword-'));

    // --- The collision file: an unrelated class whose methods are ordinary
    // English words ("check", "drain", "fire" — the only defs of those names).
    // Substantive bodies + an internal call mesh so it isn't skipped as a stub.
    const dbDir = path.join(testDir, 'src', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dbDir, 'valve.ts'),
      `export class Valve {\n` +
      `  private open = false;\n` +
      `  check(): void {\n` +
      `    if (this.open) {\n` +
      `      this.fire();\n` +
      `    }\n` +
      `  }\n` +
      `  fire(): void {\n` +
      `    this.drain();\n` +
      `    this.open = false;\n` +
      `  }\n` +
      `  drain(): void {\n` +
      `    this.open = true;\n` +
      `  }\n` +
      `}\n`);

    // --- The answer file: the upgrade module the query is actually about.
    // Its path and symbol names match the query's topic terms (upgrade,
    // latest, version), so the corroboration ranking scores it — the bug was
    // the collision file's named tier sorting ABOVE it anyway.
    const upDir = path.join(testDir, 'src', 'upgrade');
    fs.mkdirSync(upDir, { recursive: true });
    fs.writeFileSync(path.join(upDir, 'updater.ts'),
      `export function normalizeVersion(v: string): string {\n` +
      `  return v.startsWith('v') ? v : 'v' + v;\n` +
      `}\n` +
      `export function resolveLatestVersion(): string {\n` +
      `  return normalizeVersion('9.9.9');\n` +
      `}\n` +
      `export function runUpgrade(): string {\n` +
      `  const latest = resolveLatestVersion();\n` +
      `  return latest;\n` +
      `}\n`);

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function explore(query: string): Promise<string> {
    const res = await handler.execute('codegraph_explore', { query });
    expect(res.isError).toBeFalsy();
    return res.content[0]!.text;
  }

  it('a bare English word ("check") does not tier its namesake above the corroborated answer file', async () => {
    const text = await explore('how does the upgrade flow check the latest version');
    const files = sourcedFiles(text);
    const updater = files.findIndex((f) => f.endsWith('updater.ts'));
    const valve = files.findIndex((f) => f.endsWith('valve.ts'));
    // The upgrade module must render, and must rank above the collision file
    // (pre-guard, valve.ts held the named-FIRST tier and sorted on top).
    expect(updater).toBeGreaterThanOrEqual(0);
    if (valve !== -1) expect(updater).toBeLessThan(valve);
  });

  it('a sibling bag of bare words ("check drain fire") still tiers their shared file first', async () => {
    const text = await explore('check drain fire');
    const files = sourcedFiles(text);
    // Every token is co-named by the others in valve.ts — genuine bare-name
    // symbol bags must keep the named tier.
    expect(files[0]).toMatch(/valve\.ts$/);
  });

  it('a shape-precise token (camelCase) seeds unconditionally', async () => {
    const text = await explore('runUpgrade');
    const files = sourcedFiles(text);
    expect(files[0]).toMatch(/updater\.ts$/);
  });
});
