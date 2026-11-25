import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

let dir: string;
let cg: CodeGraph;

async function index(files: Record<string, string> = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-empty-explore-'));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), source);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}

async function explore(query: string) {
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query });
  expect(result.isError).toBeFalsy();
  return result.content[0]!.text;
}

afterEach(() => {
  cg?.destroy();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const registration = {
  'src/users.py': 'class RegistrationService:\n    def create_account(self):\n        return 1\n\nclass RateLimiter:\n    def check_limit(self):\n        return False\n',
};

describe('empty explore diagnostics (#1904)', () => {
  it('explains a synonym miss without claiming the concept or all query words are absent', async () => {
    await index(registration);
    const text = await explore('how do we stop users signing up too fast');
    expect(text).toContain('No relevant code found');
    expect(text).toContain('lexically, not by meaning');
    expect(text).toMatch(/No lexical matches[^\n]*`signing`/);
    // The file name is indexed, even though no relevant subgraph was returned.
    expect(text).toMatch(/Matched indexed words[^\n]*`users`/);
    expect(text).toContain('codegraph_explore');
    expect(text).not.toMatch(/use (?:Read|grep)/i);
  });

  it('leaves the literal control on the normal source-rendering path', async () => {
    await index(registration);
    const text = await explore('throttle signup limit');
    expect(text).toContain('check_limit');
    expect(text).not.toContain('No lexical matches');
    expect(text).not.toContain('lexically, not by meaning');
  });

  it('reports an empty index explicitly', async () => {
    await index();
    expect(await explore('signup throttle')).toContain('This project has nothing indexed');
  });

  it('keeps unresolved paths separate from word diagnostics', async () => {
    await index(registration);
    const text = await explore('missing/phantom.py signing');
    expect(text).toContain('no indexed file uniquely matches `missing/phantom.py`');
    expect(text).toMatch(/No lexical matches[^\n]*`signing`/);
    expect(text).not.toMatch(/No lexical matches[^\n]*`phantom`/);
  });

  it.each(['py', 'ts'])('offers real sub-word candidates for filtered words (%s)', async (language) => {
    await index({
      [`logic.${language}`]: language === 'py'
        ? 'def explainHowThingsWork():\n    return 1\n'
        : 'export function explainHowThingsWork() { return 1; }\n',
    });
    const text = await explore('how');
    expect(text).toContain('No relevant code found');
    expect(text).toMatch(/Matched indexed words[^\n]*`how`/);
    expect(text).toContain('Candidates to retry with codegraph_explore');
    expect(text).toContain('`explainHowThingsWork`');
    expect(await explore('explainHowThingsWork')).toContain('return 1');
  });

  it('recognizes docstring-only matches without inventing name candidates', async () => {
    await index({ 'logic.ts': '/** with */\nexport function frobnicate() { return 1; }\n' });
    expect(cg.getNodesByName('frobnicate')[0]?.docstring).toContain('with');
    const text = await explore('with');
    expect(text).toContain('No relevant code found');
    expect(text).toMatch(/Matched indexed words[^\n]*`with`/);
    expect(text).not.toContain('`frobnicate`');
  });

  it('offers FTS name-prefix candidates even without an exact segment match', async () => {
    await index({ 'logic.ts': 'export function withholdValue() { return 1; }\n' });
    const text = await explore('with');
    expect(text).toContain('No relevant code found');
    expect(text).toMatch(/Matched indexed words[^\n]*`with`/);
    expect(text).toContain('`withholdValue`');
  });

  it('does not offer deleted symbols left in the segment vocabulary', async () => {
    await index({ ...registration, 'logic.py': 'def explainHowThingsWork():\n    return 1\n' });
    fs.unlinkSync(path.join(dir, 'logic.py'));
    await cg.sync();
    const text = await explore('how');
    expect(text).toMatch(/No lexical matches[^\n]*`how`/);
    expect(text).not.toContain('explainHowThingsWork');
  });

  it('handles punctuation and bounded Unicode words without an error', async () => {
    await index(registration);
    const text = await explore('"???"');
    expect(text).toContain('No relevant code found');
    expect(text).toContain('codegraph_explore');
    const miss = cg.getExploreMissDiagnostics('未知词 " OR * ' + 'z'.repeat(80));
    expect(miss.unmatched).toContain('未知词');
    expect(miss.limited).toBe(true);
  });

  it('caps diagnostics and candidate names', async () => {
    await index({
      'logic.py': Array.from({ length: 24 }, (_, i) =>
        `def explainHowVariant${i}():\n    return ${i}\n`).join('\n'),
    });
    const query = 'how ' + Array.from({ length: 40 }, (_, i) => `zzmissing${i}`).join(' ');
    const text = await explore(query);
    expect(text).toContain('No relevant code found');
    expect(text.length - `No relevant code found for "${query}"`.length).toBeLessThanOrEqual(1500);
    const candidates = text.match(/`explainHowVariant\d+`/g) ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(12);
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
