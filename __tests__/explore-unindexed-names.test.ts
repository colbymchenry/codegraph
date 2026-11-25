/**
 * Names the query spells that the index has never seen are said plainly,
 * instead of answering with code that only matched the query's other words
 * (#2462).
 *
 * A .NET repo kept real tool projects in a root `build/` folder, which the
 * default skip list leaves unindexed. `codegraph_explore "ReleaseNotesBuilder
 * Program Main ChangelogParser PersistentData Entry AddFeatures"` came back as
 * an unrelated `Program.Main` and a C++ `Parser`, with nothing to say that four
 * of the names matched nothing. The agent read the wrong code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, isIdentifierShapedToken } from '../src/mcp/tools';

const QUERY = 'ReleaseNotesBuilder Program Main ChangelogParser PersistentData Entry AddFeatures';
const MISSING = ['ReleaseNotesBuilder', 'ChangelogParser', 'PersistentData', 'AddFeatures'];

/** The report's layout: the product under src/, its release tooling under a root build/. */
const FILES: Record<string, string> = {
  '.gitignore': 'bin/\nobj/\n',
  'src/Agent/Program.cs': `namespace Agent
{
    public static class Program
    {
        public static int Main(string[] args)
        {
            var host = new AgentHost();
            return host.Run(args);
        }
    }

    public class AgentHost
    {
        public int Run(string[] args) { return args.Length; }
    }
}
`,
  'src/native/parser.cpp': `#include <string>
namespace native {
class Parser {
public:
  explicit Parser(std::string text) : text_(std::move(text)) {}
  int parse() { return static_cast<int>(text_.size()); }
private:
  std::string text_;
};
}  // namespace native
`,
  // `ChangelogWriter` and `auditTrail` are seen only through a docstring and a
  // folder name, never as a symbol.
  'src/auditTrail/trail.ts': `/** Hands the audit entries to the ChangelogWriter. */
export function recordTrail(): number { return 1; }
`,
  // Indexed as `handle`, with no `app.` on it, as express's own is.
  'src/server/app.js': `const app = {};
app.handle = function handle(req, res) { return res; };
module.exports = app;
`,
  'build/ReleaseNotesBuilder/Program.cs': `namespace ReleaseNotesBuilder
{
    public static class Program
    {
        public static int Main(string[] args)
        {
            var parser = new ChangelogParser(args[0]);
            var data = PersistentData.Load(args[1]);
            foreach (var entry in parser.Entries()) entry.AddFeatures(data);
            return 0;
        }
    }
}
`,
  'build/ReleaseNotesBuilder/ChangelogParser.cs': `using System.Collections.Generic;
namespace ReleaseNotesBuilder
{
    public class ChangelogParser
    {
        private readonly string _path;
        public ChangelogParser(string path) { _path = path; }
        public IEnumerable<Entry> Entries() { yield return new Entry(_path); }
    }
}
`,
  'build/ReleaseNotesBuilder/Entry.cs': `using System.Collections.Generic;
namespace ReleaseNotesBuilder
{
    public class Entry
    {
        private readonly List<string> _features = new List<string>();
        public Entry(string title) { }
        public void AddFeatures(PersistentData data) { _features.AddRange(data.Features); }
    }
}
`,
  'build/ReleaseNotesBuilder/PersistentData.cs': `using System.Collections.Generic;
namespace ReleaseNotesBuilder
{
    public class PersistentData
    {
        public List<string> Features { get; } = new List<string>();
        public static PersistentData Load(string path) { return new PersistentData(); }
    }
}
`,
};

describe('#2462 — explore says which named symbols are not in the index', () => {
  let dir: string;
  let cg: CodeGraph;
  const explore = async (query: string) => {
    const result = await new ToolHandler(cg).execute('codegraph_explore', { query });
    return { text: result.content?.[0]?.text ?? '', isError: result.isError === true };
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2462-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  }, 120_000);

  afterAll(() => {
    cg?.destroy();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fixture shape: the root build/ folder is skipped by default, so its names are not indexed', () => {
    expect(cg.getFiles().map((f) => f.path).filter((p) => p.startsWith('build/'))).toEqual([]);
    expect(cg.getNodesByName('Main').map((n) => n.filePath)).toEqual(['src/Agent/Program.cs']);
  });

  it('names the missing symbols above the unrelated matches, success-shaped', async () => {
    const { text, isError } = await explore(QUERY);
    expect(isError).toBe(false);
    expect(text).toContain(`**Not in the index:** ${MISSING.map((n) => `\`${n}\``).join(', ')}.`);
    expect(text).toContain("so the code below matches the query's other words, not them");
    // Above the source, where it is read first.
    expect(text.indexOf('**Not in the index:**')).toBeLessThan(text.indexOf('**`src/Agent/Program.cs`**'));
    // Where to look, never "Read"; including a skipped folder is the user's call.
    expect(text).toContain('`codegraph status` shows what is.');
    expect(text).toContain('the user can include that folder by adding a re-include such as `!/build/` to `.gitignore`.');
    expect(text).not.toMatch(/\bRead (?:the|these|those|it)\b/);
  });

  it('never names a single word, which may be English, nor a name the index has', async () => {
    const { text } = await explore(QUERY);
    const note = text.split('\n').find((l) => l.startsWith('> **Not in the index:**'))!;
    for (const word of ['Program', 'Main', 'Entry']) expect(note).not.toContain(`\`${word}\``);
    expect((await explore('Program Main AgentHost Run')).text).not.toContain('Not in the index');
    expect((await explore('How does the agent host run its main program?')).text).not.toContain('Not in the index');
  });

  it('a name seen only in a docstring or a folder name is in the index', () => {
    expect(cg.getUnseenNames(['ChangelogWriter', 'auditTrail', 'agenthost', 'Agent.Program', ...MISSING]))
      .toEqual(MISSING);
  });

  it('a qualified name is in the index when its member is, whatever the receiver', () => {
    // `app.handle` is indexed as `handle`; only a member never seen makes it missing.
    expect(cg.getUnseenNames(['app.handle', 'Zorblax.frobnicate', 'pkg::recordTrail'])).toEqual(['Zorblax.frobnicate']);
  });

  it('says so too when nothing matched at all', async () => {
    const { text, isError } = await explore('ReleaseNotesBuilder PersistentData');
    expect(isError).toBe(false);
    expect(text).toContain('No relevant code found');
    expect(text).toContain('**Not in the index:** `ReleaseNotesBuilder`, `PersistentData`.');
    expect(text).not.toContain('the code below');
  });

  it('goes away once the folder is re-included and synced', async () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'bin/\nobj/\n!/build/\n');
    await cg.sync();
    const { text } = await explore(QUERY);
    expect(text).not.toContain('Not in the index');
    expect(text).toContain('build/ReleaseNotesBuilder/ChangelogParser.cs');
  }, 120_000);
});

describe('isIdentifierShapedToken', () => {
  it('takes names written like code and leaves single words alone', () => {
    for (const t of ['ChangelogParser', 'addFeatures', 'build_report', 'MAX_SIZE', 'Session.request', 'pkg::run', '$store.items']) {
      expect(isIdentifierShapedToken(t), t).toBe(true);
    }
    for (const t of ['Program', 'Main', 'How', 'parser', 'SQL', 'i18n', 'v1.2']) {
      expect(isIdentifierShapedToken(t), t).toBe(false);
    }
  });
});
