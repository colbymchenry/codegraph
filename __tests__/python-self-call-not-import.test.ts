/**
 * A Python call written on the instance, `self.get_ip(request)`, is a method
 * call even when the file also imports a function named `get_ip`. The
 * extractor records it by its bare name, and the import strategy claimed it:
 * django-allauth's `DefaultAccountAdapter.send_notification_mail` calling
 * `self.get_client_ip(self.request)` was linked to `httpkit.get_client_ip`,
 * which `adapter.py` imports, instead of the adapter's own method.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Python self-calls do not resolve through a same-named import', () => {
  const dirs: string[] = [];
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function callsIn(files: Record<string, string>): Promise<string[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-py-self-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    cg = await CodeGraph.init(dir, { index: true });
    const rows = (cg as any).db.db
      .prepare(
        `SELECT s.qualified_name s, t.qualified_name t, t.file_path f FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.kind = 'calls'`,
      )
      .all() as { s: string; t: string; f: string }[];
    return rows.map((r) => `${r.s} -> ${r.t} (${r.f})`).sort();
  }

  const httpkit = 'def get_ip(request):\n    return "1.2.3.4"\n';

  it('a method calling its own same-named method through self', async () => {
    expect(
      await callsIn({
        'pkg/__init__.py': '',
        'pkg/httpkit.py': httpkit,
        'pkg/adapter.py': [
          'from pkg.httpkit import get_ip',
          '',
          '',
          'class Adapter:',
          '    def get_ip(self, request):',
          '        return get_ip(request)',
          '',
          '    def notify(self, request):',
          '        return self.get_ip(request)',
          '',
        ].join('\n'),
      }),
    ).toEqual([
      // The bare call is still the imported function.
      'Adapter::get_ip -> get_ip (pkg/httpkit.py)',
      'Adapter::notify -> Adapter::get_ip (pkg/adapter.py)',
    ]);
  });

  it('a method a base class in another file declares', async () => {
    expect(
      await callsIn({
        'pkg/__init__.py': '',
        'pkg/httpkit.py': httpkit,
        'pkg/base.py': 'class Base:\n    def get_ip(self, request):\n        return "base"\n',
        'pkg/adapter.py': [
          'from pkg.base import Base',
          'from pkg.httpkit import get_ip',
          '',
          '',
          'class Adapter(Base):',
          '    def notify(self, request):',
          '        return self.get_ip(request)',
          '',
          '    def raw(self, request):',
          '        return get_ip(request)',
          '',
        ].join('\n'),
      }),
    ).toEqual([
      'Adapter::notify -> Base::get_ip (pkg/base.py)',
      'Adapter::raw -> get_ip (pkg/httpkit.py)',
    ]);
  });
});
