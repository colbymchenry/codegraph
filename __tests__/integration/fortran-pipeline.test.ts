/**
 * Fortran end-to-end pipeline integration tests
 *
 * Covers the Fortran-specific resolution semantics that unit tests can't:
 *   - cross-module CALL through `use ..., only:` resolves to a call edge
 *   - case-insensitive resolution (declared lowercase, called UPPERCASE)
 *   - free subroutine declared via an anonymous INTERFACE block
 *   - type-bound procedure calls (`CALL obj%Run()`) resolving onto the
 *     receiver's declared type binding, the binding→implementation edge,
 *     and the fortran-override dispatch bridge along EXTENDS edges
 *   - array indexing NOT producing call edges to variables
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/index';

function createTempDir(prefix = 'codegraph-fortran-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeProject(root: string): void {
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });

  fs.writeFileSync(
    path.join(src, 'mod_engine.f90'),
    `module mod_engine
  implicit none

  type, abstract :: base_engine_t
  contains
    procedure, pass :: Integrate => BaseIntegrate
  end type base_engine_t

  type, extends(base_engine_t) :: cpg_engine_t
  contains
    procedure :: Integrate => CpgIntegrate
  end type cpg_engine_t

contains

  subroutine BaseIntegrate(this)
    class(base_engine_t), intent(inout) :: this
  end subroutine BaseIntegrate

  subroutine CpgIntegrate(this)
    class(cpg_engine_t), intent(inout) :: this
    call helper_lowercase()
  end subroutine CpgIntegrate

  subroutine helper_lowercase()
  end subroutine helper_lowercase
end module mod_engine
`
  );

  fs.writeFileSync(
    path.join(src, 'free_sub.f90'),
    `subroutine free_standalone()
end subroutine free_standalone
`
  );

  fs.writeFileSync(
    path.join(src, 'driver.f90'),
    `module mod_driver
  use mod_engine, only: base_engine_t, cpg_engine_t
  implicit none
  real :: shared_array(10)
contains
  subroutine drive(eng)
    class(base_engine_t), intent(inout) :: eng
    integer :: i
    interface
      subroutine free_standalone()
      end subroutine free_standalone
    end interface
    call eng%Integrate()
    call HELPER_LOWERCASE()
    call free_standalone()
    do i = 1, 10
      shared_array(i) = shared_array(i) + 1.0
    end do
  end subroutine drive
end module mod_driver
`
  );
}

describe('Integration: Fortran pipeline', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    tempDir = createTempDir();
    writeProject(tempDir);
    cg = await CodeGraph.init(tempDir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function edgesBetween(sourceName: string, targetName: string) {
    const queries = (cg as unknown as { queries: import('../../src/db/queries').QueryBuilder }).queries;
    const sources = queries.getNodesByLowerName(sourceName.toLowerCase());
    const targets = new Set(
      queries.getNodesByLowerName(targetName.toLowerCase()).map((n) => n.id)
    );
    return sources.flatMap((s) =>
      queries.getOutgoingEdges(s.id, ['calls']).filter((e) => targets.has(e.target))
    );
  }

  it('resolves case-mismatched calls (declared lowercase, called UPPERCASE)', () => {
    expect(edgesBetween('drive', 'helper_lowercase').length).toBeGreaterThan(0);
  });

  it('resolves a call to a free subroutine declared via an anonymous INTERFACE block', () => {
    expect(edgesBetween('drive', 'free_standalone').length).toBeGreaterThan(0);
  });

  it('resolves CALL obj%Integrate() onto the declared type binding (method node)', () => {
    const queries = (cg as unknown as { queries: import('../../src/db/queries').QueryBuilder }).queries;
    const baseBinding = queries
      .getNodesByLowerName('integrate')
      .find((n) => n.kind === 'method' && n.qualifiedName.includes('base_engine_t'));
    expect(baseBinding).toBeDefined();
    const drive = queries.getNodesByLowerName('drive').find((n) => n.kind === 'function');
    expect(drive).toBeDefined();
    const callEdges = queries
      .getOutgoingEdges(drive!.id, ['calls'])
      .filter((e) => e.target === baseBinding!.id);
    expect(callEdges.length).toBeGreaterThan(0);
  });

  it('links the binding to its implementation subroutine', () => {
    expect(edgesBetween('integrate', 'cpgintegrate').length).toBeGreaterThan(0);
    expect(edgesBetween('integrate', 'baseintegrate').length).toBeGreaterThan(0);
  });

  it('bridges polymorphic dispatch: base binding → extending type override', () => {
    const queries = (cg as unknown as { queries: import('../../src/db/queries').QueryBuilder }).queries;
    const methods = queries.getNodesByLowerName('integrate').filter((n) => n.kind === 'method');
    const base = methods.find((n) => n.qualifiedName.includes('base_engine_t'));
    const override = methods.find((n) => n.qualifiedName.includes('cpg_engine_t'));
    expect(base).toBeDefined();
    expect(override).toBeDefined();
    const bridge = queries
      .getOutgoingEdges(base!.id, ['calls'])
      .filter((e) => e.target === override!.id);
    expect(bridge.length).toBeGreaterThan(0);
    expect(bridge[0]!.metadata?.synthesizedBy).toBe('fortran-override');
  });

  it('does not create call edges from array indexing to variables', () => {
    const queries = (cg as unknown as { queries: import('../../src/db/queries').QueryBuilder }).queries;
    const arr = queries.getNodesByLowerName('shared_array');
    for (const n of arr) {
      const incoming = queries.getIncomingEdges(n.id, ['calls']);
      expect(incoming.length).toBe(0);
    }
  });
});
