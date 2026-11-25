/**
 * VB.NET names that begin with a keyword.
 *
 * The vendored grammar lexed the member modifiers (`Public`, `Shared`, `Dim`,
 * `Const`, …) as one token that outranked identifiers, so the lexer stopped at
 * the end of a modifier spelled at the start of a name: `Public SharedCache As
 * Integer` indexed a field `Cache`, `Public Dimension` a field `ension`,
 * `Private FriendlyNameValue` (staxrip) a field `lyNameValue`, and `Public
 * Shared Shared1` lost the field to a parse error. Inside a method `Dim` and
 * `Const` did the same: `ConstVBV.Value = False` (staxrip) parsed as a
 * declaration `Const VBV`, and `ConstructPath()` as `Const ructPath()`. And
 * `Sub NewItem()` lexed as the constructor `Sub New` followed by `Item`.
 *
 * Two things the old lexing got right only by accident are pinned too: the
 * attribute lines above a top-level declaration belong to it, and `Option`
 * lines may follow a comment banner.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

// The issue's class, verbatim.
const HOLDER = `Public Class Holder
    Public Shared Shared1 As Integer
    Public Shared SharedCache As Integer
    Public Dimension As Integer
    Public Endpoint As String
    Public PublicKey As String
    Private Property1 As Integer
    Public Shared Function SharedHelper() As Integer
        Return 1
    End Function
    Public Sub EndSession()
    End Sub
    Public Normal As Integer
End Class
`;

const MODIFIERS = [
  'Public', 'Private', 'Protected', 'Friend', 'ReadOnly', 'WriteOnly', 'Shared', 'Shadows', 'MustInherit',
  'NotInheritable', 'Overrides', 'NotOverridable', 'Overridable', 'Overloads', 'WithEvents', 'Widening',
  'Narrowing', 'Partial', 'Async', 'Iterator', 'Dim', 'Const', 'Static', 'MustOverride',
];

function namesOf(source: string, kind: string): string[] {
  return extractFromSource('Probe.vb', source).nodes.filter((n) => n.kind === kind).map((n) => n.name);
}

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['vbnet']);
});

describe('VB.NET names that begin with a keyword', () => {
  it('index the fields of the issue under their whole names', () => {
    expect(namesOf(HOLDER, 'field'))
      .toEqual(['Shared1', 'SharedCache', 'Dimension', 'Endpoint', 'PublicKey', 'Property1', 'Normal']);
    expect(namesOf(HOLDER, 'method')).toEqual(['SharedHelper', 'EndSession']);
  });

  it('keep every member modifier out of a name it begins, in any case', () => {
    const source = [
      'Public Class Fields',
      ...MODIFIERS.flatMap((m) => [
        `    Private ${m}Field As Integer`,
        `    PUBLIC SHARED ${m.toUpperCase()}UPPER As Integer`,
        `    friend ${m.toLowerCase()}lower As Integer`,
      ]),
      'End Class',
      '',
    ].join('\n');
    expect(namesOf(source, 'field')).toEqual(
      MODIFIERS.flatMap((m) => [`${m}Field`, `${m.toUpperCase()}UPPER`, `${m.toLowerCase()}lower`]),
    );
  });

  it('still read the modifiers themselves', () => {
    const source = `Public Class Settings
    Public Shared ReadOnly Limit As Integer = 1
    Public Shared SharedCache As Integer
    Protected Friend Inherited As Integer
    Private Protected Derived As Integer
    Friend FriendlyName As String
    Private Const ConstantRate As Integer = 2
End Class
`;
    const fields = new Map(extractFromSource('Probe.vb', source).nodes
      .filter((n) => n.kind === 'field' || n.kind === 'constant')
      .map((n) => [n.name, n]));
    expect([...fields.keys()]).toEqual(['Limit', 'SharedCache', 'Inherited', 'Derived', 'FriendlyName', 'ConstantRate']);
    expect(fields.get('SharedCache')?.isStatic).toBe(true);
    expect(fields.get('Inherited')?.visibility).toBe('protected');
    // `Private Protected` was one token that matched no visibility, so it read as public.
    expect(fields.get('Derived')?.visibility).toBe('private');
    expect(fields.get('FriendlyName')?.visibility).toBe('internal');
  });

  it('tell Sub New from a method whose name begins with New', () => {
    const source = `Public Class Menu
    Public Sub New()
    End Sub
    Shared Sub New()
    End Sub
    Private Sub NewFromDefaultsToolStripMenuItem_Click() Handles NewFromDefaultsToolStripMenuItem.Click
    End Sub
    Public Sub NewItem()
    End Sub
End Class
`;
    expect(namesOf(source, 'method')).toEqual(['New', 'New', 'NewFromDefaultsToolStripMenuItem_Click', 'NewItem']);
  });

  it('keep a statement that begins with Dim or Const a statement', () => {
    const source = `Public Class Encoder
    Private ConstVBV As New BoolParam()
    Sub Apply()
        ConstVBV.Value = False
        ConstVBV.Reset()
        ConstructPath()
        DimSomething()
        Constants.Reload()
        Dim constructor As Object = Nothing
        constructor = Nothing
    End Sub
End Class
`;
    const result = extractFromSource('Probe.vb', source);
    expect(result.nodes.filter((n) => n.kind === 'field').map((n) => n.name)).toEqual(['ConstVBV']);
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls' || r.referenceKind === 'references')
      .map((r) => `${r.referenceKind} ${r.referenceName}`);
    expect(refs).toEqual([
      'references ConstVBV.Value',
      'calls ConstVBV.Reset',
      'calls ConstructPath',
      'calls DimSomething',
      'calls Constants.Reload',
    ]);
  });
});

describe('VB.NET top-level lines', () => {
  it('give a declaration every attribute line above it', () => {
    const source = `Imports System

<Serializable>
<ComVisible(False)>
Public Class Settings
End Class

<Serializable>
Class Plain
End Class
`;
    const classes = extractFromSource('Probe.vb', source).nodes.filter((n) => n.kind === 'class');
    expect(classes.map((n) => [n.name, n.startLine])).toEqual([['Settings', 3], ['Plain', 8]]);
  });

  it('parse Option lines after a comment banner', () => {
    const source = `'------------------------------------------------------------------------------
' <auto-generated>
'     This code was generated by a tool.
' </auto-generated>
'------------------------------------------------------------------------------

Option Strict On
Option Explicit On

Namespace My.Resources
    Friend Module Resources
    End Module
End Namespace
`;
    const tree = getParser('vbnet')!.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.descendantsOfType('option_statement')).toHaveLength(2);
    } finally {
      tree.delete();
    }
  });
});

describe('VB.NET references to keyword-prefixed names', () => {
  let root = '';
  let cg: CodeGraph;
  const files: Record<string, string> = {
    'Holder.vb': HOLDER.replace('    Public Normal As Integer\n', `    Public Normal As Integer
    Public Sub NewItem()
    End Sub
`),
    'Constants.vb': `Public Module Constants
    Public Sub Reload()
    End Sub
End Module
`,
    'User.vb': `Public Class User
    Public Sub Run(x As Holder)
        Dim a As Integer = Holder.Dimension
        Holder.SharedCache = 2
        Dim c As Integer = Holder.Shared1 + Holder.SharedHelper()
        Dim h As New Holder()
        h.NewItem()
        Constants.Reload()
    End Sub
End Class
`,
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-keyword-names-'));
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), content);
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function linkedFrom(qualifiedName: string, kind: 'references' | 'calls'): string[] {
    const found = cg.getNodesInFiles(Object.keys(files)).filter((n) => n.qualifiedName === qualifiedName);
    expect(found.map((n) => n.qualifiedName)).toEqual([qualifiedName]);
    return cg.getIncomingEdgesTo([found[0]!.id], [kind]).map((e) => cg.getNode(e.source)!.qualifiedName);
  }

  it('link reads and writes through the class to the field', () => {
    expect(linkedFrom('Holder::Dimension', 'references')).toEqual(['User::Run']);
    expect(linkedFrom('Holder::SharedCache', 'references')).toEqual(['User::Run']);
    expect(linkedFrom('Holder::Shared1', 'references')).toEqual(['User::Run']);
  });

  it('link calls to methods whose names begin with a keyword', () => {
    expect(linkedFrom('Holder::SharedHelper', 'calls')).toEqual(['User::Run']);
    expect(linkedFrom('Holder::NewItem', 'calls')).toEqual(['User::Run']);
    expect(linkedFrom('Constants::Reload', 'calls')).toEqual(['User::Run']);
  });
});
