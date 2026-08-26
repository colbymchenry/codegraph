/**
 * Chinese filename retrieval through codegraph_explore (#1372).
 *
 * Exact Chinese filenames are already indexed and searchable through
 * `codegraph query`, but explore drops a Han-only filename before it can reach
 * the indexed file.
 *
 * The locked invariant: an exact Chinese filename reaches explore without
 * turning partial Chinese terms into broader filename search or overriding
 * explicit node-kind filters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('Chinese filename retrieval (#1372)', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1372-'));
    fs.writeFileSync(
      path.join(testDir, '示例模块.lua'),
      'local M = {}\nreturn M\n'
    );
    fs.writeFileSync(
      path.join(testDir, '示例模块扩展.lua'),
      'local Extension = {}\nreturn Extension\n'
    );
    for (const fileName of ['用户Service.lua', '用户模块2.lua', '用户-登录.lua']) {
      fs.writeFileSync(
        path.join(testDir, fileName),
        'local MixedName = {}\nreturn MixedName\n'
      );
    }
    fs.writeFileSync(
      path.join(testDir, '用户.v2.lua'),
      'local DottedStem = {}\nreturn DottedStem\n'
    );
    fs.writeFileSync(
      path.join(testDir, '深度模块.svelte'),
      '<script>const exactLongName = {};</script>\n'
    );
    for (let i = 0; i < 24; i++) {
      fs.writeFileSync(
        path.join(testDir, `深度模块扩展${i}.c`),
        `int prefix_noise_${i}(void) { return ${i}; }\n`
      );
    }

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.lua', '**/*.c', '**/*.svelte'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns a file whose exact Chinese name is the explore query', async () => {
    const result = await handler.execute('codegraph_explore', { query: '示例模块' });
    const text = result.content[0]!.text as string;

    expect(result.isError).toBeFalsy();
    expect(text).toContain('示例模块.lua');
    expect(text).not.toContain('示例模块扩展.lua');
    expect(text).not.toContain('No relevant code found');
  });

  it('does not treat a partial Chinese name as an exact filename', async () => {
    const result = await handler.execute('codegraph_explore', { query: '示例' });
    const text = result.content[0]!.text as string;

    expect(text).not.toContain('示例模块.lua');
    expect(text).not.toContain('示例模块扩展.lua');
  });

  it('supports exact Chinese filenames mixed with ASCII, digits, and separators', async () => {
    for (const query of ['用户Service', '用户模块2', '用户-登录']) {
      const result = await handler.execute('codegraph_explore', { query });
      const text = result.content[0]!.text as string;

      expect(result.isError).toBeFalsy();
      expect(text).toContain(`${query}.lua`);
      expect(text).not.toContain('No relevant code found');
    }
  });

  it('matches a dotted stem with or without the final extension', async () => {
    for (const query of ['用户.v2', '用户.v2.lua']) {
      const result = await handler.execute('codegraph_explore', { query });
      const text = result.content[0]!.text as string;

      expect(result.isError).toBeFalsy();
      expect(text).toContain('用户.v2.lua');
      expect(text).not.toContain('No relevant code found');
    }
  });

  it('does not lose an exact stem behind a large prefix candidate set', async () => {
    const result = await handler.execute('codegraph_explore', { query: '深度模块' });
    const text = result.content[0]!.text as string;

    expect(result.isError).toBeFalsy();
    expect(text).toContain('深度模块.svelte');
    expect(text).not.toContain('No relevant code found');
  });

  it('does not override an explicit node-kind filter', async () => {
    const context = await cg.findRelevantContext('示例模块', {
      nodeKinds: ['function'],
    });

    expect([...context.nodes.values()].some((node) => node.kind === 'file')).toBe(false);
  });
});
