/**
 * A C++ range-based for loop declares the receiver its body calls through.
 *
 * protocolbuffers/protobuf's conformance runner loops `for
 * (ConformanceTestSuite *suite : suites)` and calls `suite->SetVerbose(…)`,
 * `suite->RunSuite(…)` and `suite->GetFailureListFlagName()` in the body.
 * Receiver inference reads a declaration only when the declared name is
 * followed by `;`, `=`, `,`, `)`, `[`, `{` or `(`, so it never read a loop's
 * `Type name :` and the calls fell through to a guess by the receiver's name.
 * A guess can still land on the right method by a shared word, so these tests
 * check how the edge was made (the typed path's confidence), not only where
 * it goes.
 *
 * The loop's variable is in scope in the loop's body only: after the loop, or
 * in another function, a receiver of the same name is some other variable.
 * A `for` in a comment or a string literal declares nothing, and a colon
 * outside a loop's header never ends a declaration: not a bit-field's
 * (`unsigned car : 1;`), nor the scope operator's (`void parts::Install()`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-range-for-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function callable(cg: CodeGraph, qualifiedName: string): Node {
  const node = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName);
  if (!node) throw new Error(`no function or method ${qualifiedName}`);
  return node;
}

/** `calls` callees of a function or method, as `qualifiedName @confidence`, one per call site. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} @${(r.edge.metadata as { confidence?: number } | undefined)?.confidence}`)
    .sort();
}

/** protocolbuffers/protobuf's conformance runner, trimmed; `FlagParser` is a decoy `SetVerbose`. */
const CONFORMANCE = {
  'conformance/suite.h': [
    '#include <string>',
    'namespace google {',
    'namespace protobuf {',
    'class ConformanceTestRunner {',
    ' public:',
    '  virtual ~ConformanceTestRunner() = default;',
    '};',
    'class ConformanceTestSuite {',
    ' public:',
    '  void SetVerbose(bool verbose) { verbose_ = verbose; }',
    '  std::string GetFailureListFlagName() { return failure_list_flag_name_; }',
    '  bool RunSuite(ConformanceTestRunner* runner, std::string* output,',
    '                const std::string& filename);',
    ' private:',
    '  bool verbose_ = false;',
    '  std::string failure_list_flag_name_;',
    '};',
    'class FlagParser {',
    ' public:',
    '  void SetVerbose(bool verbose) {}',
    '};',
    '}  // namespace protobuf',
    '}  // namespace google',
    '',
  ].join('\n'),
  'conformance/suite.cc': [
    '#include "conformance/suite.h"',
    'namespace google {',
    'namespace protobuf {',
    'bool ConformanceTestSuite::RunSuite(ConformanceTestRunner* runner, std::string* output,',
    '                                    const std::string& filename) {',
    '  return true;',
    '}',
    '}  // namespace protobuf',
    '}  // namespace google',
    '',
  ].join('\n'),
  'conformance/runner.cc': [
    '#include <cstring>',
    '#include <vector>',
    '#include "conformance/suite.h"',
    'namespace google {',
    'namespace protobuf {',
    'int ForkPipeRunnerMain(int argc, char* argv[], const std::vector<ConformanceTestSuite*>& suites) {',
    '  bool verbose = false;',
    '  for (ConformanceTestSuite *suite : suites) {',
    '    std::string failure_list_filename;',
    '    for (int arg = 1; arg < argc; ++arg) {',
    '      if (strcmp(argv[arg], suite->GetFailureListFlagName().c_str()) == 0) {',
    '        failure_list_filename = argv[arg];',
    '      }',
    '    }',
    '    suite->SetVerbose(verbose);',
    '    std::string output;',
    '    ConformanceTestRunner* runner = nullptr;',
    '    verbose = verbose && suite->RunSuite(runner, &output,',
    '                                         failure_list_filename);',
    '  }',
    '  return 0;',
    '}',
    '}  // namespace protobuf',
    '}  // namespace google',
    '',
  ].join('\n'),
};

/** Two `Start`s no receiver name below points at, and a class whose member is named like a loop variable. */
const GARAGE = {
  'garage/vehicle.h': [
    '#include <vector>',
    'namespace garage {',
    'class Engine {',
    ' public:',
    '  void Start();',
    '  int Torque() const;',
    '};',
    'class Car {',
    ' public:',
    '  void Start();',
    '};',
    'namespace parts {',
    'class Part {',
    ' public:',
    '  void Fit();',
    '};',
    'void Install();',
    '}  // namespace parts',
    '}  // namespace garage',
    '',
  ].join('\n'),
  'garage/vehicle.cc': [
    '#include "garage/vehicle.h"',
    'namespace garage {',
    'void Engine::Start() {}',
    'int Engine::Torque() const { return 0; }',
    'void Car::Start() {}',
    'void parts::Part::Fit() {}',
    '}  // namespace garage',
    '',
  ].join('\n'),
  'garage/garage.h': [
    '#include "garage/vehicle.h"',
    'namespace garage {',
    'class Garage {',
    ' public:',
    '  void Inspect(const std::vector<Engine*>& engines);',
    '  void Service();',
    ' private:',
    '  Car* car;',
    '};',
    '}  // namespace garage',
    '',
  ].join('\n'),
  'garage/garage.cc': [
    '#include "garage/garage.h"',
    'namespace garage {',
    'void Garage::Inspect(const std::vector<Engine*>& engines) {',
    '  for (Engine* car : engines) car->Start();',
    '}',
    'void Garage::Service() {',
    '  car->Start();',
    '}',
    '}  // namespace garage',
    '',
  ].join('\n'),
};

describe('a C++ range-based for declares its loop variable', () => {
  it('reproduction: protobuf\'s conformance runner calls the suite\'s methods through the typed path', async () => {
    const cg = await indexed(CONFORMANCE);
    try {
      // The guess by the receiver's name lands on the same methods (0.65 /
      // 0.7); the loop's declared type makes them certain.
      expect(calls(cg, 'google::protobuf::ForkPipeRunnerMain')).toEqual([
        'google::protobuf::ConformanceTestSuite::GetFailureListFlagName @0.9',
        'google::protobuf::ConformanceTestSuite::RunSuite @0.9',
        'google::protobuf::ConformanceTestSuite::SetVerbose @0.9',
      ]);
    } finally {
      cg.close();
    }
  });

  it('a loop variable that hides a member is the element, not the member', async () => {
    const cg = await indexed(GARAGE);
    try {
      // Reading on past the loop reached the member `Car* car;` in the header.
      expect(calls(cg, 'garage::Garage::Inspect')).toEqual(['garage::Engine::Start @0.9']);
    } finally {
      cg.close();
    }
  });

  it('after the loop, and in another function, a same-named receiver is not the loop\'s variable', async () => {
    const cg = await indexed({
      ...GARAGE,
      'garage/fleet.cc': [
        '#include "garage/vehicle.h"',
        'namespace garage {',
        'void Drive(Car* engine, const std::vector<Engine*>& engines) {',
        '  for (Engine* engine : engines) {',
        '    engine->Start();',
        '  }',
        '  engine->Start();',
        '}',
        'void Wash(Car* engine, const std::vector<Engine*>& engines) {',
        '  for (Engine* engine : engines) engine->Start();',
        '  engine->Start();',
        '}',
        '}  // namespace garage',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'garage::Drive')).toEqual(['garage::Car::Start @0.9', 'garage::Engine::Start @0.9']);
      // A loop without braces ends with its one statement.
      expect(calls(cg, 'garage::Wash')).toEqual(['garage::Car::Start @0.9', 'garage::Engine::Start @0.9']);
      // Garage::Service's `car` is the member, though Inspect's loop above it names one `car`.
      expect(calls(cg, 'garage::Garage::Service')).toEqual(['garage::Car::Start @0.9']);
    } finally {
      cg.close();
    }
  });

  it('reads references, pointers, qualified and global-scope types, and a header split over lines', async () => {
    const cg = await indexed({
      ...GARAGE,
      'garage/shop.cc': [
        '#include "garage/vehicle.h"',
        'namespace garage {',
        'void ByReference(std::vector<Engine>& engines) {',
        '  for (Engine& e : engines) e.Start();',
        '}',
        'void ByConstReference(const std::vector<Engine>& engines) {',
        '  for (const Engine& e : engines) {',
        '    if (e.Torque() > 0) {}',
        '  }',
        '}',
        'void StarOnName(const std::vector<Engine*>& engines) {',
        '  for (Engine *e : engines)',
        '    e->Start();',
        '}',
        'void Qualified(const std::vector<parts::Part*>& list) {',
        '  for (::garage::parts::Part* p : list) p->Fit();',
        '}',
        'void SplitHeader(const std::vector<Engine*>& engines) {',
        '  for (Engine* first_engine_in_the_list :',
        '       engines) {',
        '    first_engine_in_the_list->Start();',
        '  }',
        '}',
        '}  // namespace garage',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'garage::ByReference')).toEqual(['garage::Engine::Start @0.9']);
      expect(calls(cg, 'garage::ByConstReference')).toEqual(['garage::Engine::Torque @0.9']);
      expect(calls(cg, 'garage::StarOnName')).toEqual(['garage::Engine::Start @0.9']);
      expect(calls(cg, 'garage::Qualified')).toEqual(['garage::parts::Part::Fit @0.9']);
      expect(calls(cg, 'garage::SplitHeader')).toEqual(['garage::Engine::Start @0.9']);
    } finally {
      cg.close();
    }
  });

  it('a brace in a comment or a string literal does not end the loop', async () => {
    const cg = await indexed({
      ...GARAGE,
      'garage/braces.cc': [
        '#include "garage/vehicle.h"',
        'namespace garage {',
        'void Braces(const std::vector<Engine*>& engines) {',
        '  for (Engine* e : engines) {',
        '    // A comment\'s } is not the loop\'s.',
        '    const char* close = "}";',
        '    /* nor is } this one',
        '       } or this */',
        '    char brace = \'}\';',
        '    e->Start();',
        '  }',
        '}',
        '}  // namespace garage',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'garage::Braces')).toEqual(['garage::Engine::Start @0.9']);
    } finally {
      cg.close();
    }
  });

  it('a nested loop\'s call is inside the outer loop\'s body', async () => {
    const cg = await indexed({
      ...GARAGE,
      'garage/nested.cc': [
        '#include "garage/vehicle.h"',
        'namespace garage {',
        'void Nested(const std::vector<parts::Part*>& list) {',
        '  for (parts::Part* p : list) {',
        '    for (int i = 0; i < 2; ++i) {',
        '      if (i) { p->Fit(); }',
        '    }',
        '  }',
        '}',
        '}  // namespace garage',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'garage::Nested')).toEqual(['garage::parts::Part::Fit @0.9']);
    } finally {
      cg.close();
    }
  });
});

describe('what declares no loop variable', () => {
  it('a `for` in a comment or a string literal', async () => {
    const cg = await indexed({
      ...GARAGE,
      'garage/notes.cc': [
        '#include <string>',
        '#include "garage/vehicle.h"',
        'namespace garage {',
        'void Commented(Car* car) {',
        '  // for (Engine* car : engines) {',
        '  car->Start();',
        '}',
        'void Inline(Car* car) {',
        '  /* for (Engine* car : engines) { */ car->Start();',
        '}',
        'std::string Template(Car* car) {',
        '  std::string code = "for (Engine* car : engines) {";',
        '  car->Start();',
        '  return code + "}";',
        '}',
        '}  // namespace garage',
        '',
      ].join('\n'),
    });
    try {
      expect(calls(cg, 'garage::Commented')).toEqual(['garage::Car::Start @0.9']);
      expect(calls(cg, 'garage::Inline')).toEqual(['garage::Car::Start @0.9']);
      expect(calls(cg, 'garage::Template')).toEqual(['garage::Car::Start @0.9']);
    } finally {
      cg.close();
    }
  });

  it('a bit-field', async () => {
    const cg = await indexed({
      ...GARAGE,
      'garage/lot.h': [
        '#include "garage/vehicle.h"',
        'namespace garage {',
        'struct Slot {',
        '  unsigned car : 1;',
        '};',
        'class Lot {',
        ' public:',
        '  void Park();',
        ' private:',
        '  Car* car;',
        '};',
        '}  // namespace garage',
        '',
      ].join('\n'),
      'garage/lot.cc': [
        '#include "garage/lot.h"',
        'namespace garage {',
        'void Lot::Park() {',
        '  car->Start();',
        '}',
        '}  // namespace garage',
        '',
      ].join('\n'),
    });
    try {
      // The member `Car* car;`, not Slot's `unsigned car : 1;` above it.
      expect(calls(cg, 'garage::Lot::Park')).toEqual(['garage::Car::Start @0.9']);
    } finally {
      cg.close();
    }
  });

  it('a name followed by the scope operator', async () => {
    const cg = await indexed({
      ...GARAGE,
      'garage/bay.h': [
        '#include "garage/vehicle.h"',
        'namespace garage {',
        'class Bay {',
        ' public:',
        '  void Open();',
        '  void Fit(const std::vector<parts::Part*>& list);',
        ' private:',
        '  Car* parts;',
        '};',
        '}  // namespace garage',
        '',
      ].join('\n'),
      'garage/bay.cc': [
        '#include "garage/bay.h"',
        'namespace garage {',
        'void parts::Install() {}',
        'void Bay::Open() {',
        '  parts->Start();',
        '}',
        'void Bay::Fit(const std::vector<parts::Part*>& list) {',
        '  for (parts::Part* part : list) parts->Start();',
        '}',
        '}  // namespace garage',
        '',
      ].join('\n'),
    });
    try {
      // `void parts::Install()` declares no `parts`; the member does.
      expect(calls(cg, 'garage::Bay::Open')).toEqual(['garage::Car::Start @0.9']);
      // `parts::Part` declares the loop's `part`; the receiver `parts` is still the member.
      expect(calls(cg, 'garage::Bay::Fit')).toEqual(['garage::Car::Start @0.9']);
    } finally {
      cg.close();
    }
  });
});
