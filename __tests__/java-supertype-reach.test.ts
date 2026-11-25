/**
 * What a Java type inherits decides which nested types are in reach of it, and
 * so what a bare `Reader` or `GeoGrid` can mean there.
 *
 * The walk up the supertypes kept one memo for every type, filled at whatever
 * depth a type was first reached: a type met at the depth limit was remembered
 * with its own header's names alone, and every shallower walk through it then
 * stopped there. The answer depended on which reference was resolved first, so
 * on how a batch was split across workers. elasticsearch's `GetSynonymsAction`
 * lost the `Reader` it inherits from `Writeable`. Each type now walks for itself.
 *
 * The walk also went through every type of a supertype's name. elasticsearch's
 * `InternalGeoGrid implements GeoGrid` means its own package's interface, but a
 * record `BlockLoaderFunctionConfig.GeoGrid` shares the name and implements its
 * owner, so `BlockLoaderFunctionConfig` passed for an ancestor, and that record
 * for a nested type in reach, and it took the `implements` from the interface.
 *
 * C#'s walk kept the same memo, and walks the same way now.
 *
 * `Template::lifecycle` is the `Template` the file can see, as any bare type name
 * is: with an import of `cluster.metadata.Template` elasticsearch's method
 * reference met a record `Template`'s accessor nested in another class, and two
 * candidates in other files resolved it to nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const ROOT = 'server/src/main/java/org/es';
const CHAIN: Record<string, string> = {};
// `Deep` sorts first, so its reference is resolved first, and on main reached the walk's limit at L3.
for (let i = 0; i < 6; i++) CHAIN[`src/o/L${i}.java`] = `package o;\n\npublic class L${i} extends L${i + 1} {\n}\n`;

const FILES: Record<string, string> = {
  ...CHAIN,
  'src/o/L6.java': 'package o;\n\npublic class L6 implements Writer {\n}\n',
  'src/o/Writer.java': 'package o;\n\npublic interface Writer {\n    interface Reader<V> {\n    }\n}\n',
  'src/o/Deep.java': 'package o;\n\npublic class Deep extends L0 {\n    Reader<String> farUp() { return null; }\n}\n',
  'src/o/Near.java': 'package o;\n\npublic class Near extends L3 {\n    Reader<String> inherited() { return null; }\n}\n',
  // elasticsearch's BytesKeyedBucketOrds: the anonymous class's supertype is its own file's.
  'src/o/Own.java': 'package o;\n\npublic class Own {\n    public interface Scanner {\n    }\n    Object make(Theirs theirs) {\n        Theirs.Scanner other = theirs.scanner();\n        return new Scanner() {\n        };\n    }\n}\n',
  'src/o/Theirs.java': 'package o;\n\npublic class Theirs {\n    public interface Scanner {\n    }\n    Scanner scanner() { return null; }\n}\n',
  // A name written through a package or a type, in a class that inherits one of that name.
  'src/o/Holder.java': 'package o;\n\npublic class Holder {\n    public interface Bucket {\n        interface Reader<B> {\n        }\n    }\n}\n',
  'src/o/Written.java': 'package o;\n\nimport o.Holder.Bucket;\n\npublic class Written extends L6 {\n    java.io.Reader throughPackage() { return null; }\n    Bucket.Reader<String> throughType() { return null; }\n}\n',
  // elasticsearch's two GeoGrids, deep enough that the path says nothing between them.
  [`${ROOT}/search/aggregations/bucket/geogrid/GeoGrid.java`]: 'package org.es.search.aggregations.bucket.geogrid;\n\npublic interface GeoGrid {\n}\n',
  [`${ROOT}/search/aggregations/bucket/geogrid/InternalGeoGrid.java`]: 'package org.es.search.aggregations.bucket.geogrid;\n\npublic abstract class InternalGeoGrid<B> extends Base<\n    InternalGeoGrid<B>,\n    B> implements GeoGrid {\n}\n',
  [`${ROOT}/search/aggregations/bucket/geogrid/Base.java`]: 'package org.es.search.aggregations.bucket.geogrid;\n\npublic abstract class Base<A, B> {\n}\n',
  [`${ROOT}/index/mapper/blockloader/BlockLoaderFunctionConfig.java`]: 'package org.es.index.mapper.blockloader;\n\npublic sealed interface BlockLoaderFunctionConfig {\n    record GeoGrid(int precision) implements BlockLoaderFunctionConfig {\n    }\n}\n',
  // C#'s nested types are in reach the same way.
  'cs/Types.cs': 'namespace O\n{\n    public class CL6 : CWriter { }\n    public class CL5 : CL6 { }\n    public class CL4 : CL5 { }\n    public class CL3 : CL4 { }\n    public class CL2 : CL3 { }\n    public class CL1 : CL2 { }\n    public class CL0 : CL1 { }\n    public interface CWriter\n    {\n        public interface CReader<V> { }\n    }\n}\n',
  'cs/ADeep.cs': 'namespace O\n{\n    public class ADeep : CL0\n    {\n        CReader<string> FarUp() { return null; }\n    }\n}\n',
  'cs/Near.cs': 'namespace O\n{\n    public class Near : CL3\n    {\n        CReader<string> Inherited() { return null; }\n    }\n}\n',
  // elasticsearch's `Template::lifecycle`, and the record's accessor of that name.
  'src/c/Template.java': 'package c;\n\npublic class Template {\n    public String lifecycle() { return ""; }\n}\n',
  'src/d/FailureStore.java': 'package d;\n\npublic class FailureStore {\n    public record Template(String lifecycle, int enabled) {\n    }\n}\n',
  'src/e/Use.java': 'package e;\n\nimport c.Template;\nimport java.util.Optional;\n\npublic class Use {\n    Object viaImport(Template t) {\n        return Optional.ofNullable(t).map(Template::lifecycle);\n    }\n}\n',
  // A nested type its subclass inherits, in another package, stays in reach.
  'src/p/Outer.java': 'package p;\n\npublic class Outer {\n    public static class Helper {\n    }\n}\n',
  'src/q/Sub.java': 'package q;\n\nimport p.Outer;\n\npublic class Sub extends Outer {\n    Helper helper() { return null; }\n}\n',
};

describe('what a Java type inherits', () => {
  let dir: string;
  let cg: CodeGraph;

  const referenced = (method: string): string[] => {
    const from = cg.getNodesByKind('method').find((n) => n.name === method);
    expect(from, method).toBeDefined();
    return cg.getOutgoingEdges(from!.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!.qualifiedName);
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-supertypes-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    cg = await CodeGraph.init(dir, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not depend on a walk from further down having passed first', () => {
    expect(referenced('inherited')).toEqual(['o::Writer::Reader']);
  });

  it('goes all the way up', () => {
    expect(referenced('farUp')).toEqual(['o::Writer::Reader']);
  });

  it('takes a name written through a package for that package\'s', () => {
    expect(referenced('throughPackage')).toEqual([]);
  });

  it('reads the qualifier of this reference, not of a line near it', () => {
    const anon = cg.getNodesByKind('class').find((n) => n.name.startsWith('<Scanner$anon@'))!;
    const implemented = cg.getOutgoingEdges(anon.id).filter((e) => e.kind === 'implements' || e.kind === 'extends').map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(implemented).toEqual(['o::Own::Scanner']);
  });

  it('takes a name written through a type for the one nested in it', () => {
    expect(referenced('throughType')).toContain('o::Holder::Bucket::Reader');
    expect(referenced('throughType')).not.toContain('o::Writer::Reader');
  });

  it('does not depend on that in C# either', () => {
    expect(referenced('FarUp')).toEqual(['O::CWriter::CReader']);
    expect(referenced('Inherited')).toEqual(['O::CWriter::CReader']);
  });

  it('goes through the supertype the file can see, not a namesake nested elsewhere', () => {
    const internal = cg.getNodesByKind('class').find((n) => n.name === 'InternalGeoGrid')!;
    const implemented = cg.getOutgoingEdges(internal.id).filter((e) => e.kind === 'implements').map((e) => cg.getNode(e.target)!);
    expect(implemented.map((n) => `${n.kind} ${n.qualifiedName}`)).toEqual(['interface org.es.search.aggregations.bucket.geogrid::GeoGrid']);
  });

  it('takes `Type::method` to the type the file can see', () => {
    expect(referenced('viaImport')).toContain('c::Template::lifecycle');
  });

  it('keeps a nested type a subclass inherits from another package', () => {
    expect(referenced('helper')).toEqual(['p::Outer::Helper']);
  });
});
