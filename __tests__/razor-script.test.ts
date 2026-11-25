/**
 * What is left of a Razor view's `<script>` for a JavaScript grammar to read:
 * the JavaScript, at the offsets it had, with every Razor construct gone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { blankRazorComments, blankRazorInScript, isJavaScriptBlock } from '../src/extraction/razor-script';

/** What survives, with runs of blanks closed up. */
const left = (source: string): string => blankRazorInScript(source).replace(/\s+/g, ' ').trim();

describe('blankRazorInScript', () => {
  it('keeps every offset and line', () => {
    const source = [
      'var id = @Model.Id;',
      '@if (Model.Show)',
      '{',
      '    <text>show();</text>',
      '}',
      'done();',
    ].join('\r\n');
    const out = blankRazorInScript(source);
    expect(out).toHaveLength(source.length);
    expect(out.split('\n')).toHaveLength(source.split('\n').length);
    expect(out.indexOf('show();')).toBe(source.indexOf('show();'));
    expect(out.indexOf('done();')).toBe(source.indexOf('done();'));
  });

  it('leaves a script with no Razor as it is', () => {
    const source = "function save() { return fetch('/x'); }\n";
    expect(blankRazorInScript(source)).toBe(source);
  });

  it('turns an expression into a value', () => {
    expect(left('var id = @Model.Id;')).toBe('var id = 0 ;');
    expect(left('var sum = @(a + (b * 2));')).toBe('var sum = 0 ;');
    expect(left('var one = @Model.Items[0].Name;')).toBe('var one = 0 ;');
    expect(left('var safe = @Model?.Name;')).toBe('var safe = 0 ;');
    expect(left('var html = @Html.Raw(Json.Serialize(Model.Items));')).toBe('var html = 0 ;');
    expect(left('var part = @await Html.PartialAsync("Row");')).toBe('var part = 0 ;');
    expect(left('var link = @Url.Action("Add", new { id = 1, name = ")" });')).toBe('var link = 0 ;');
    expect(left('var typed = @Html.Partial<Row>("x");')).toBe('var typed = 0 ;');
  });

  it('leaves what is around an expression inside a string', () => {
    expect(left(`$('#@Html.IdFor(m => m.Id)').hide();`)).toBe(`$('#0 ').hide();`);
    expect(left(`alert('@T("Saved")');`)).toBe(`alert('0 ');`);
  });

  it('takes an address for text, and an escaped @ for nothing', () => {
    expect(left(`var a = 'me@example.com';`)).toBe(`var a = 'me@example.com';`);
    expect(left(`var b = '@@scope/pkg';`)).toBe(`var b = ' @scope/pkg';`);
  });

  it('blanks comments and code blocks', () => {
    expect(left('a(); @* b(); *@ c();')).toBe('a(); c();');
    expect(left('a(); @{ var x = "}"; Do(x); } c();')).toBe('a(); c();');
  });

  it('keeps what a control statement emits and drops its C#', () => {
    expect(left(`@if (Model.Show) { <text>show();</text> } else { var y = Compute(); }`)).toBe('show();');
    expect(left(`@if (a) { <text>one();</text> } else if (b) { <text>two();</text> } else { <text>three();</text> } after();`)).toBe('one(); two(); three(); after();');
    expect(left(`@foreach (var x in Model.Items) { @:add('@x.Name');\n } after();`)).toBe(`add('0 '); after();`);
    expect(left(`@try { Risky(); } catch (Exception e) { <text>failed();</text> } finally { Done(); }`)).toBe('failed();');
  });

  it('reads Razor inside what a statement emits', () => {
    expect(left(`@if (a) { <text>var id = @Model.Id; @if (b) { <text>nested();</text> } </text> }`)).toBe('var id = 0 ; nested();');
  });

  it('survives what it cannot close', () => {
    expect(left('a(); @if (open')).toBe('a();');
    expect(left('a(); @(open')).toBe('a(); @(open');
    expect(left('a(); @* open')).toBe('a();');
  });
});

describe('blankRazorComments', () => {
  it('blanks a commented-out block, offsets kept', () => {
    const source = 'a @* <script>x();</script> *@ b';
    const out = blankRazorComments(source);
    expect(out).toHaveLength(source.length);
    expect(out).not.toContain('script');
    expect(out.indexOf('b')).toBe(source.indexOf(' b') + 1);
  });
});

describe('isJavaScriptBlock', () => {
  it.each([
    ['', true],
    [' asp-location="Footer"', true],
    [' type="text/javascript"', true],
    [' type="module"', true],
    [" type='application/javascript'", true],
    [' type="text/babel"', true],
    [' type="text/html"', false],
    [' type="text/template"', false],
    [' type="text/x-jsrender"', false],
    [' type="application/json"', false],
    [' type="application/ld+json"', false],
    [' type="@pageType"', false],
  ])('%s → %s', (attrs, expected) => {
    expect(isJavaScriptBlock(attrs)).toBe(expected);
  });
});

describe('a view in a project with no JavaScript file', () => {
  let dir: string;
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('still has its script read: the view asks for the grammars it needs', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-razor-grammar-'));
    fs.mkdirSync(path.join(dir, 'Views'));
    fs.writeFileSync(path.join(dir, 'Views/Page.cshtml'), '@{ var x = Compute(); }\n<script>\n  loadPage();\n</script>\n');
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const db = (cg as unknown as { db: { db: { prepare(sql: string): { all(): Array<{ reference_name: string; language: string }> } } } }).db.db;
    const refs = db.prepare('SELECT reference_name, language FROM unresolved_refs').all().map((r) => `${r.language}:${r.reference_name}`);
    cg.close();
    expect(refs).toContain('javascript:loadPage');
    expect(refs).toContain('razor:Compute');
  });
});
