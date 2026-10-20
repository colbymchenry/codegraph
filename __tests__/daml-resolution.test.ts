/**
 * Haskell / DAML reference resolution (src/resolution/haskell-modules.ts).
 *
 * Qualified references are extracted as `Module::name` with import aliases
 * expanded, so they match node qualified names exactly; a shared alias lists
 * every candidate module, a re-export resolves to the re-exported declaration,
 * and the copy nearest the caller wins when a module exists twice. Bare names
 * follow Haskell scoping: only the module itself and what it imports
 * unqualified are visible, so a standard-library call never binds to an
 * unrelated project declaration of the same name.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

let cg: CodeGraph | undefined;
let dir: string | undefined;

afterEach(() => {
  cg?.destroy();
  cg = undefined;
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-daml-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  cg = CodeGraph.initSync(dir, { config: { include: ['**/*.daml'], exclude: [] } });
  await cg.indexAll();
  return cg;
}

function node(graph: CodeGraph, qualifiedName: string, filePrefix = ''): Node {
  const found = graph.getNodesByQualifiedName(qualifiedName).filter((n) => n.filePath.startsWith(filePrefix));
  expect(found, `${qualifiedName} in ${filePrefix || 'any file'}`).toHaveLength(1);
  return found[0]!;
}

/** Target qualified names (with file) of `from`'s outgoing edges of `kind`. */
function targets(graph: CodeGraph, from: Node, kind: 'calls' | 'references' | 'instantiates' | 'implements' | 'extends'): string[] {
  const edges = graph.getOutgoingEdgesFrom([from.id], [kind]);
  const byId = graph.getNodesByIds(edges.map((e) => e.target));
  return edges.map((e) => `${byId.get(e.target)!.qualifiedName} @ ${byId.get(e.target)!.filePath}`);
}

const UTIL = `module Lib.Util where

feeFor : Decimal -> Decimal
feeFor x = x * 0.01

type I = Holding

interface Holding where
  viewtype HV
  amountOf : Decimal

data HV = HV with owner : Party
`;

describe('DAML qualified references', () => {
  it('resolves aliased and fully qualified calls, and interface instances through `type I = X`', async () => {
    const graph = await index({
      'Lib/Util.daml': UTIL,
      'Main.daml': `module Main where

import Lib.Util qualified as U
import qualified Lib.Util

a = U.feeFor 1.0
b = Lib.Util.feeFor 2.0

template T
  with
    p : Party
  where
    signatory p
    interface instance U.I for T where
      view = U.HV with owner = p
      amountOf = 1.0
`,
    });
    expect(targets(graph, node(graph, 'Main::a'), 'calls')).toEqual(['Lib.Util::feeFor @ Lib/Util.daml']);
    expect(targets(graph, node(graph, 'Main::b'), 'calls')).toEqual(['Lib.Util::feeFor @ Lib/Util.daml']);
    expect(targets(graph, node(graph, 'Main::T'), 'implements')).toEqual(['Lib.Util::Holding @ Lib/Util.daml']);
  });

  it('links a script exercise to the choice, and a prepared choice argument to the choice', async () => {
    const graph = await index({
      'Token.daml': `module Token where

template Asset
  with
    owner : Party
  where
    signatory owner
    choice Give : ContractId Asset
      with
        to : Party
      controller owner
      do create this with owner = to
`,
      'Test.daml': `module Test where

import Token qualified as Tok

run cid = do
  exerciseCmd cid Tok.Give with to = alice

prepare = Tok.Give with to = alice
`,
    });
    const give = 'Token::Give @ Token.daml';
    expect(targets(graph, node(graph, 'Test::run'), 'calls')).toEqual([give]);
    expect(targets(graph, node(graph, 'Test::prepare'), 'instantiates')).toEqual([give]);
  });

  it('picks the candidate module of a shared alias that declares the name', async () => {
    const graph = await index({
      'A.daml': 'module A where\n\nfromA : Int -> Int\nfromA x = x\n',
      'B.daml': 'module B where\n\nfromB : Int -> Int\nfromB x = x\n',
      'Main.daml': 'module Main where\n\nimport A qualified as X\nimport B qualified as X\n\nf = X.fromB\ng = X.fromA 1\nh = X.fromB 2\n',
    });
    expect(targets(graph, node(graph, 'Main::g'), 'calls')).toEqual(['A::fromA @ A.daml']);
    expect(targets(graph, node(graph, 'Main::h'), 'calls')).toEqual(['B::fromB @ B.daml']);
  });

  it('follows a re-export to the declaring module', async () => {
    const graph = await index({
      'Utils/Internal.daml': 'module Utils.Internal where\n\nbasicAccount : Int -> Int\nbasicAccount x = x\n',
      'Utils.daml': 'module Utils (basicAccount) where\n\nimport Utils.Internal\n',
      'Main.daml': 'module Main where\n\nimport Utils qualified as U\nimport Utils\n\nq = U.basicAccount 1\nb = basicAccount 2\n',
    });
    const declared = 'Utils.Internal::basicAccount @ Utils/Internal.daml';
    expect(targets(graph, node(graph, 'Main::q'), 'calls')).toEqual([declared]);
    expect(targets(graph, node(graph, 'Main::b'), 'calls')).toEqual([declared]);
  });

  it('resolves to the copy of a module nearest the caller', async () => {
    const util = 'module Util where\n\nhelper : Int -> Int\nhelper x = x\n';
    const main = 'module Main where\n\nimport Util qualified as U\n\nf = U.helper 1\n';
    const graph = await index({
      'src/Util.daml': util,
      'src/Main.daml': main,
      'docs/generated/src/Util.daml': util,
      'docs/generated/src/Main.daml': main,
    });
    expect(targets(graph, node(graph, 'Main::f', 'src/'), 'calls')).toEqual(['Util::helper @ src/Util.daml']);
    expect(targets(graph, node(graph, 'Main::f', 'docs/'), 'calls'))
      .toEqual(['Util::helper @ docs/generated/src/Util.daml']);
  });
});

describe('Haskell scoping for bare names', () => {
  const OBSERVATION = 'module Observation where\n\npure : Int -> Int\npure x = x\n\ntime : Int\ntime = 0\n';

  it('never binds a call to a declaration of a module the file does not import', async () => {
    const graph = await index({
      'Observation.daml': OBSERVATION,
      'Main.daml': 'module Main where\n\nimport DA.Time (time)\n\nf = pure 1\ng = time\nh = pure (time 2)\n',
    });
    expect(targets(graph, node(graph, 'Main::f'), 'calls')).toEqual([]);
    expect(targets(graph, node(graph, 'Main::h'), 'calls')).toEqual([]);
  });

  it('binds a call to an unqualified import, within its import list', async () => {
    const graph = await index({
      'Observation.daml': OBSERVATION,
      'Uses.daml': 'module Uses where\n\nimport Observation (pure)\n\nf = pure 1\ng = time 2\n',
    });
    expect(targets(graph, node(graph, 'Uses::f'), 'calls')).toEqual(['Observation::pure @ Observation.daml']);
    expect(targets(graph, node(graph, 'Uses::g'), 'calls')).toEqual([]);
  });

  it('never binds a standard-library class method to a project instance of it', async () => {
    const graph = await index({
      'Types.daml': 'module Types where\n\nnewtype Id = Id Text\n\ninstance Show Id where\n  show (Id t) = t\n',
      'Main.daml': 'module Main where\n\nimport Types\n\nf i = show i\n',
    });
    expect(targets(graph, node(graph, 'Main::f'), 'calls')).toEqual([]);
  });

  it('imports only a type\'s constructors, fields and methods with `T(..)`, not other names', async () => {
    const graph = await index({
      'Observation.daml': OBSERVATION,
      'Claim.daml': 'module Claim (Inequality(..), lte) where\n\nimport Observation\n\ndata Inequality = Lte Int\n\nlte : Int -> Inequality\nlte = Lte\n',
      'Main.daml': 'module Main where\n\nimport Claim (Inequality(..), lte)\nimport Observation qualified as O\n\nf = pure 1\ng = lte 1\n',
    });
    expect(targets(graph, node(graph, 'Main::f'), 'calls')).toEqual([]);
    expect(targets(graph, node(graph, 'Main::g'), 'calls')).toEqual(['Claim::lte @ Claim.daml']);
  });

  it('never binds a call to one instance implementation of a class method', async () => {
    const graph = await index({
      'Pretty.daml': `module Pretty where

class Pretty a where
  pretty : a -> Text

instance Pretty Int where
  pretty x = show x
`,
      'Main.daml': 'module Main where\n\nimport Pretty\n\nf = pretty 1\n',
    });
    expect(targets(graph, node(graph, 'Main::f'), 'calls')).toEqual(['Pretty::pretty @ Pretty.daml']);
  });
});

const HOLDING = `module Iface.Holding where

interface Holding where
  viewtype V
  transferImpl : Party -> Update (ContractId Holding)

  choice Transfer : ContractId Holding
    with
      to : Party
    controller (view this).owner
    do transferImpl this to

data V = V with owner : Party
`;

const TOKEN = `module Token where

import Iface.Holding qualified as Holding

type T = Token

template Token
  with
    owner : Party
  where
    signatory owner
    key owner : Party
    maintainer key

    interface instance Holding.Holding for Token where
      view = Holding.V with owner
      transferImpl to = toInterfaceContractId <$> create this with owner = to
`;

describe('DAML ledger actions and interface dispatch', () => {
  it('calls the template a ledger action names: imported, through a type alias, or `this`', async () => {
    const graph = await index({
      'Iface/Holding.daml': HOLDING,
      'Token.daml': TOKEN,
      'Bank.daml': `module Bank where

import Token (Token(..))
import Token qualified as Tok

open : Party -> Update (ContractId Token)
open p = create Token with owner = p

look : Party -> Update (ContractId Token)
look p = fst <$> fetchByKey @Tok.T p
`,
    });
    const token = 'Token::Token @ Token.daml';
    expect(targets(graph, node(graph, 'Bank::open'), 'calls')).toEqual([token]);
    expect(targets(graph, node(graph, 'Bank::look'), 'calls')).toEqual([token]);
    expect(targets(graph, node(graph, 'Token::Token::transferImpl'), 'calls')).toEqual([token]);
    expect(targets(graph, node(graph, 'Bank::open'), 'instantiates')).toEqual([]);
  });

  it('links an interface method to every template implementing it', async () => {
    const graph = await index({ 'Iface/Holding.daml': HOLDING, 'Token.daml': TOKEN });
    expect(targets(graph, node(graph, 'Iface.Holding::Transfer'), 'calls'))
      .toEqual(['Iface.Holding::transferImpl @ Iface/Holding.daml']);
    expect(targets(graph, node(graph, 'Iface.Holding::transferImpl'), 'calls'))
      .toEqual(['Token::Token::transferImpl @ Token.daml']);
  });

  it('reads a top-level value rather than calling it, unless it is an action', async () => {
    const graph = await index({
      'Fees.daml': `module Fees where

fee : Decimal
fee = 0.1

setup : Update ()
setup = pure ()

charge : Decimal -> Update Decimal
charge x = do
  setup
  pure (x * fee)
`,
    });
    expect(targets(graph, node(graph, 'Fees::charge'), 'calls')).toEqual(['Fees::setup @ Fees.daml']);
    expect(targets(graph, node(graph, 'Fees::charge'), 'references')).toEqual(['Fees::fee @ Fees.daml']);
  });

  it('calls a local function passed as a value', async () => {
    const graph = await index({
      'Batch.daml': `module Batch where

settleAll : [Int] -> Update [Int]
settleAll steps = mapA settleOne steps
  where
    settleOne step = pure step
`,
    });
    expect(targets(graph, node(graph, 'Batch::settleAll'), 'calls')).toEqual(['Batch::settleAll::settleOne @ Batch.daml']);
  });
});
