/**
 * What resolution reads from MSBuild project files (`.fsproj`, `.csproj`,
 * `.props`): the F# compile order, the `<Using>` items, the root namespace and
 * the projects a project references. Each is read from the file's elements by
 * name, wherever they stand, as MSBuild evaluates a project without conditions.
 */

/** An element of an MSBuild file: its attributes by lower-cased name, and the text between its tags. */
export interface MsbuildElement {
  name: string;
  attributes: ReadonlyMap<string, string>;
  text: string;
}

const START_TAG = /<([A-Za-z][\w.-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The elements of `xml` named one of `names` (lower-cased), in document order. Comments and character data hold none. */
export function msbuildElements(xml: string, names: ReadonlySet<string>): MsbuildElement[] {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const found: MsbuildElement[] = [];
  for (const tag of text.matchAll(START_TAG)) {
    const name = tag[1]!;
    if (!names.has(name.toLowerCase())) continue;
    const attributes = new Map<string, string>();
    for (const a of tag[2]!.matchAll(ATTRIBUTE)) attributes.set(a[1]!.toLowerCase(), a[2] ?? a[3] ?? '');
    let inner = '';
    if (tag[3] !== '/') {
      const start = tag.index! + tag[0].length;
      const end = text.toLowerCase().indexOf(`</${name.toLowerCase()}`, start);
      inner = end < 0 ? '' : text.slice(start, end);
    }
    found.push({ name, attributes, text: inner });
  }
  return found;
}

/** The paths an item's `Include` names, with `/` separators: `A.fs;B.fs` names two; a wildcard or a property names no one file. */
function includedPaths(element: MsbuildElement): string[] {
  const include = element.attributes.get('include');
  if (include === undefined) return [];
  return include.split(';').map((i) => i.trim())
    .filter((i) => i !== '' && !/[*?]|\$\(/.test(i))
    .map((i) => i.replace(/\\/g, '/'));
}

const COMPILE_ITEMS: ReadonlySet<string> = new Set(['compilebefore', 'compile', 'compileafter']);

/**
 * A project file's compile items, with `/` separators, in the order F#
 * compiles them: `<CompileBefore>`, then `<Compile>`, then `<CompileAfter>`,
 * each in document order, whatever order the element's attributes are in.
 */
export function fsprojCompileItems(xml: string): string[] {
  const groups = new Map<string, string[]>([...COMPILE_ITEMS].map((name) => [name, []]));
  for (const element of msbuildElements(xml, COMPILE_ITEMS)) groups.get(element.name.toLowerCase())!.push(...includedPaths(element));
  return [...groups.get('compilebefore')!, ...groups.get('compile')!, ...groups.get('compileafter')!];
}

/** A `<Using Include="X" [Static="true"] [Alias="A"] />` item: the `global using` directive it stands for. */
export interface MsbuildUsing {
  /** The namespace or type `Include` names, by its full path: `Shop.Model`. */
  path: string;
  alias: string | null;
  isStatic: boolean;
}

/** The `<Using>` items of an MSBuild file. */
export function msbuildUsings(xml: string): MsbuildUsing[] {
  const usings: MsbuildUsing[] = [];
  for (const element of msbuildElements(xml, new Set(['using']))) {
    const include = element.attributes.get('include')?.trim();
    if (include === undefined || include === '') continue;
    usings.push({
      path: include,
      alias: element.attributes.get('alias')?.trim() || null,
      isStatic: element.attributes.get('static')?.trim().toLowerCase() === 'true',
    });
  }
  return usings;
}

/** The namespace a project's `<RootNamespace>` names; null where it names none. */
export function msbuildRootNamespace(xml: string): string | null {
  const named = msbuildElements(xml, new Set(['rootnamespace'])).map((e) => e.text.trim()).filter((t) => /^[\w.]+$/.test(t));
  return named.length > 0 ? named[named.length - 1]! : null;
}

/** The project files a project's `<ProjectReference>` items name, relative to its folder, with `/` separators. */
export function msbuildProjectReferences(xml: string): string[] {
  return msbuildElements(xml, new Set(['projectreference'])).flatMap(includedPaths);
}

/** What resolution reads from a project file, as text: what a sync compares to tell whether it changed. */
export function msbuildDigestText(xml: string): string {
  return [
    ...fsprojCompileItems(xml),
    '',
    ...msbuildUsings(xml).map((u) => `${u.isStatic ? 'static ' : ''}${u.alias === null ? '' : `${u.alias} = `}${u.path}`),
    '',
    msbuildRootNamespace(xml) ?? '',
    '',
    ...msbuildProjectReferences(xml),
  ].join('\n');
}
