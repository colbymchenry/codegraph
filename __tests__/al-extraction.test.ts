import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await loadGrammarsForLanguages(['al']);
});

describe('AL Extraction', () => {
  it('extracts Codeunit and procedure correctly', () => {
    const source = `
codeunit 50100 "My Test Codeunit"
{
    Access = Public;
    Subtype = Normal;

    trigger OnRun()
    begin
        Message('Hello World');
    end;

    procedure MyFunction(VarParam: Record "Sales Line")
    var
        LocalVar: Integer;
    begin
        LocalVar := 1;
        CalculateRounding(LocalVar);
    end;
}
`;

    const result = extractFromSource('test.al', source);

    expect(result.nodes.some(n => n.kind === 'class' && n.name === '"My Test Codeunit"')).toBe(true);
    expect(result.nodes.some(n => n.kind === 'method' && n.name === 'OnRun')).toBe(true);
    expect(result.nodes.some(n => n.kind === 'method' && n.name === 'MyFunction')).toBe(true);

    // Check if the reference to CalculateRounding is picked up
    const refs = result.unresolvedReferences;
    const callRef = refs.find(r => r.referenceName === 'CalculateRounding' && r.referenceKind === 'calls');
    expect(callRef).toBeDefined();
  });

  it('names enums and interfaces and extracts interface procedures', () => {
    const source = `
enum 50100 "Color"
{
    value(0; Red) { }
    value(1; "Dark Blue") { }
}

interface "Color Provider"
{
    procedure GetColor(): Enum "Color";
}
`;

    const result = extractFromSource('types.al', source);

    expect(result.nodes.some(n => n.kind === 'enum' && n.name === '"Color"')).toBe(true);
    expect(result.nodes.some(n => n.kind === 'enum_member' && n.name === 'Red')).toBe(true);
    expect(result.nodes.some(n => n.kind === 'enum_member' && n.name === '"Dark Blue"')).toBe(true);
    expect(result.nodes.some(n => n.kind === 'interface' && n.name === '"Color Provider"')).toBe(true);
    expect(result.nodes.some(n => n.kind === 'method' && n.name === 'GetColor')).toBe(true);
  });

  it('extracts table fields and nests field triggers beneath them', () => {
    const source = `
table 50101 Customer
{
    fields
    {
        field(1; Name; Text[100])
        {
            trigger OnValidate()
            begin
                ValidateName();
            end;
        }
    }
}
`;

    const result = extractFromSource('customer.al', source);
    const field = result.nodes.find(n => n.kind === 'field' && n.name === 'Name');
    const trigger = result.nodes.find(n => n.kind === 'method' && n.name === 'OnValidate');

    expect(field?.qualifiedName).toBe('Customer::Name');
    expect(trigger?.qualifiedName).toBe('Customer::Name::OnValidate');
    expect(result.edges).toContainEqual({ source: field?.id, target: trigger?.id, kind: 'contains' });
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromNodeId: trigger?.id,
        referenceName: 'ValidateName',
        referenceKind: 'calls',
      }),
    ]));
  });

  it('extracts namespaces, using directives, and extension base objects', () => {
    const source = `
namespace Contoso.Extensions;
using Microsoft.Sales.Customer;

tableextension 50102 CustomerExtension extends Customer
{
}

permissionsetextension 50103 PermissionExtension extends BasePermissionSet
{
}

profileextension ProfileExtension extends BaseProfile
{
}
`;

    const result = extractFromSource('customer-extension.al', source);
    const namespace = result.nodes.find(n => n.kind === 'namespace');
    const extension = result.nodes.find(n => n.kind === 'class' && n.name === 'CustomerExtension');
    const permissionExtension = result.nodes.find(
      n => n.kind === 'class' && n.name === 'PermissionExtension',
    );
    const profileExtension = result.nodes.find(
      n => n.kind === 'class' && n.name === 'ProfileExtension',
    );
    const using = result.nodes.find(n => n.kind === 'import');

    expect(namespace?.name).toBe('Contoso.Extensions');
    expect(extension?.qualifiedName).toBe('Contoso.Extensions::CustomerExtension');
    expect(permissionExtension?.qualifiedName).toBe('Contoso.Extensions::PermissionExtension');
    expect(profileExtension?.qualifiedName).toBe('Contoso.Extensions::ProfileExtension');
    expect(using?.name).toBe('Microsoft.Sales.Customer');
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromNodeId: extension?.id,
        referenceName: 'Customer',
        referenceKind: 'extends',
      }),
      expect.objectContaining({
        referenceName: 'Microsoft.Sales.Customer',
        referenceKind: 'imports',
      }),
      expect.objectContaining({
        fromNodeId: permissionExtension?.id,
        referenceName: 'BasePermissionSet',
        referenceKind: 'extends',
      }),
      expect.objectContaining({
        fromNodeId: profileExtension?.id,
        referenceName: 'BaseProfile',
        referenceKind: 'extends',
      }),
    ]));
  });
});
