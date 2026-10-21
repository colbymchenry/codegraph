/**
 * A C++ alias can name a class one of a class's bases declares:
 * protocolbuffers/protobuf's conformance suites write `using
 * ConformanceRequestSetting = BinaryAndJsonConformanceSuite::ConformanceRequestSetting;`,
 * a class their base `ConformanceTestSuite` declares. Following the alias
 * looked the class up only by the qualified name as spelled, which no class
 * has, so constructions through the alias stopped at the alias and calls on
 * such a variable lost their class. The aliased type is now looked up the way
 * a declared type is, a class's members through its bases too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-alias-base-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const lines = (...text: string[]): string => [...text, ''].join('\n');

/** What a function's or method's `kind` edges reach, as `qualifiedName @confidence`. */
function targets(cg: CodeGraph, qualifiedName: string, kind: 'calls' | 'instantiates'): string[] {
  const from = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName)!;
  return cg.getOutgoingEdgesFrom([from.id], [kind])
    .map((e) => `${cg.getNode(e.target)?.qualifiedName} @${(e.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

const NS = 'google::protobuf::conformance';
const SUITE = lines(
  'namespace google {',
  'namespace protobuf {',
  'namespace conformance {',
  'class ConformanceTestSuite {',
  ' public:',
  '  class ConformanceRequestSetting {',
  '   public:',
  '    ConformanceRequestSetting(int level, const char* name) {}',
  '    const char* GetTestName() const { return ""; }',
  '  };',
  '};',
  '}  // namespace conformance',
  '}  // namespace protobuf',
  '}  // namespace google',
);

describe('C++ aliases of a class a base declares', () => {
  it('reach the class through an alias spelled through the derived class', async () => {
    const cg = await indexed({
      'conformance/conformance_test.h': SUITE,
      'conformance/binary_json_conformance_suite.h': lines(
        '#include "conformance/conformance_test.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace conformance {',
        'class BinaryAndJsonConformanceSuite : public ConformanceTestSuite {};',
        'template <typename MessageType>',
        'class BinaryAndJsonConformanceSuiteImpl {',
        ' public:',
        '  void RunTest();',
        ' private:',
        '  using ConformanceRequestSetting =',
        '      BinaryAndJsonConformanceSuite::ConformanceRequestSetting;',
        '};',
        '}  // namespace conformance',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
      'conformance/binary_json_conformance_suite.cc': lines(
        '#include "conformance/binary_json_conformance_suite.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace conformance {',
        'template <typename MessageType>',
        'void BinaryAndJsonConformanceSuiteImpl<MessageType>::RunTest() {',
        '  ConformanceRequestSetting setting(1, "x");',
        '  setting.GetTestName();',
        '}',
        '// An alias the function declares itself is not indexed: read from the function.',
        'void RunLocal() {',
        '  using ConformanceRequestSetting = BinaryAndJsonConformanceSuite::ConformanceRequestSetting;',
        '  ConformanceRequestSetting local(3, "w");',
        '  local.GetTestName();',
        '}',
        '}  // namespace conformance',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      const run = `${NS}::BinaryAndJsonConformanceSuiteImpl::RunTest`;
      expect(targets(cg, run, 'instantiates')).toEqual([`${NS}::ConformanceTestSuite::ConformanceRequestSetting @0.9`]);
      expect(targets(cg, run, 'calls').filter((t) => t.includes('GetTestName')))
        .toEqual([`${NS}::ConformanceTestSuite::ConformanceRequestSetting::GetTestName @0.9`]);
      expect(targets(cg, `${NS}::RunLocal`, 'instantiates')).toEqual([`${NS}::ConformanceTestSuite::ConformanceRequestSetting @0.9`]);
      expect(targets(cg, `${NS}::RunLocal`, 'calls').filter((t) => t.includes('GetTestName')))
        .toEqual([`${NS}::ConformanceTestSuite::ConformanceRequestSetting::GetTestName @0.9`]);
    } finally {
      cg.close();
    }
  });

  it("reach the class through an alias a derived class writes with the base's name alone", async () => {
    const cg = await indexed({
      'conformance/conformance_test.h': SUITE,
      'conformance/text_format_suite.h': lines(
        '#include <string>',
        '#include "conformance/conformance_test.h"',
        'namespace google {',
        'namespace protobuf {',
        'namespace conformance {',
        'class TextFormatSuite : public ConformanceTestSuite {',
        ' public:',
        '  using Setting = ConformanceRequestSetting;',
        '  using Name = std::string;',
        '  void Run() {',
        '    Setting setting(2, "y");',
        '    setting.GetTestName();',
        '    Name name("z");',
        '  }',
        '};',
        '}  // namespace conformance',
        '}  // namespace protobuf',
        '}  // namespace google',
      ),
    });
    try {
      const run = `${NS}::TextFormatSuite::Run`;
      // (An alias of a type from outside the project still makes the alias.)
      expect(targets(cg, run, 'instantiates'))
        .toEqual([`${NS}::ConformanceTestSuite::ConformanceRequestSetting @0.9`, `${NS}::TextFormatSuite::Name @0.9`]);
      expect(targets(cg, run, 'calls').filter((t) => t.includes('GetTestName')))
        .toEqual([`${NS}::ConformanceTestSuite::ConformanceRequestSetting::GetTestName @0.9`]);
    } finally {
      cg.close();
    }
  });
});
