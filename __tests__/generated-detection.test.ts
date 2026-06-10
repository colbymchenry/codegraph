/**
 * Regression coverage for the generated-file detector that drives
 * symbol-disambiguation down-ranking. Locked here because the suffix
 * list is a contract: if a future edit drops `.pb.go`, the cosmos-sdk
 * trace endpoint regresses to the gRPC stub (see
 * `project_go_multi_module_audit` memory + the audit in #N/A).
 */

import { describe, it, expect } from 'vitest';
import { isGeneratedFile } from '../src/extraction/generated-detection';

describe('isGeneratedFile', () => {
  it('classifies Go protobuf / gRPC / pulsar / mock outputs as generated', () => {
    expect(isGeneratedFile('api/cosmos/bank/v1beta1/tx_grpc.pb.go')).toBe(true);
    expect(isGeneratedFile('x/bank/types/tx.pb.go')).toBe(true);
    expect(isGeneratedFile('api/cosmos/bank/v1beta1/tx.pulsar.go')).toBe(true);
    // cosmos-sdk uses `<base>_mocks.go`; mockgen's default is `mock_<src>.go`;
    // many projects use `<base>_mock.go`. All three are mockgen output.
    expect(isGeneratedFile('x/auth/testutil/expected_keepers_mocks.go')).toBe(true);
    expect(isGeneratedFile('internal/foo_mock.go')).toBe(true);
    expect(isGeneratedFile('mock_keeper.go')).toBe(true);
  });

  it('does not flag the hand-written keeper as generated', () => {
    expect(isGeneratedFile('x/bank/keeper/msg_server.go')).toBe(false);
    expect(isGeneratedFile('x/bank/keeper/send.go')).toBe(false);
  });

  it('catches common cross-language codegen suffixes', () => {
    expect(isGeneratedFile('app/foo.generated.ts')).toBe(true);
    expect(isGeneratedFile('app/foo.generated.tsx')).toBe(true);
    expect(isGeneratedFile('proto/bar_pb2.py')).toBe(true);
    expect(isGeneratedFile('proto/bar_pb2_grpc.py')).toBe(true);
    expect(isGeneratedFile('lib/baz.pb.cc')).toBe(true);
    expect(isGeneratedFile('lib/baz.pb.h')).toBe(true);
    expect(isGeneratedFile('lib/quux.g.dart')).toBe(true);
    expect(isGeneratedFile('lib/quux.freezed.dart')).toBe(true);
  });

  it('leaves ordinary source files alone', () => {
    expect(isGeneratedFile('src/index.ts')).toBe(false);
    expect(isGeneratedFile('src/components/Foo.tsx')).toBe(false);
    expect(isGeneratedFile('lib/main.dart')).toBe(false);
    expect(isGeneratedFile('cmd/server/main.go')).toBe(false);
    expect(isGeneratedFile('app/db.py')).toBe(false);
  });
});
