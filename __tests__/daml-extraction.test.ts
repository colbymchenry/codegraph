/**
 * DAML extraction (tree-sitter-daml, which extends tree-sitter-haskell).
 *
 * A template is a class and its choices are methods: together they are the
 * contract's ledger API, so they are always exported and public. Ledger
 * actions become references: `exercise cid C with ...` calls choice C,
 * `T with ...` instantiates T, `interface instance I for T` makes T implement
 * I. Qualified names are written in the resolver's `Module::name` form with
 * import aliases expanded.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, initGrammars, isSourceFile, loadAllGrammars } from '../src/extraction/grammars';
import type { Node, UnresolvedReference } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const ASSET = `module Token.Asset where

import Token.Util qualified as U
import Daml.Finance.Interface.Holding.V4.Holding qualified as Holding

-- | A fungible asset.
template Asset
  with
    issuer : Party
    owner : Party
    amount : Decimal
  where
    signatory issuer, owner
    ensure U.checkPositive amount

    choice Transfer : ContractId TransferProposal
      -- ^ Propose a new owner.
      with
        newOwner : Party
      controller owner
      do
        create TransferProposal with asset = this; newOwner

    nonconsuming choice Peek : Decimal
      controller owner
      do pure amount

    interface instance Holding.I for Asset where
      view = Holding.View with owner
      getAmount = amount

template TransferProposal
  with
    asset : Asset
    newOwner : Party
  where
    signatory asset.issuer
    observer newOwner

    choice Accept : ContractId Asset
      controller newOwner
      do create asset with owner = newOwner
`;

function find(nodes: Node[], kind: string, name: string): Node {
  const node = nodes.find((n) => n.kind === kind && n.name === name);
  expect(node, `${kind} ${name}`).toBeDefined();
  return node!;
}

function refsFrom(refs: UnresolvedReference[], from: Node, kind: string): string[] {
  return refs.filter((r) => r.fromNodeId === from.id && r.referenceKind === kind).map((r) => r.referenceName);
}

describe('DAML language detection', () => {
  it('maps .daml files to the daml language', () => {
    expect(detectLanguage('daml/Token/Asset.daml')).toBe('daml');
    expect(isSourceFile('daml/Token/Asset.daml')).toBe(true);
  });
});

describe('DAML templates and choices', () => {
  it('extracts a template as an exported class with its fields and clauses in the signature', () => {
    const { nodes, errors } = extractFromSource('daml/Token/Asset.daml', ASSET);
    expect(errors).toEqual([]);
    const asset = find(nodes, 'class', 'Asset');
    expect(asset.language).toBe('daml');
    expect(asset.isExported).toBe(true);
    expect(asset.visibility).toBe('public');
    expect(asset.decorators).toEqual(['template']);
    expect(asset.docstring).toBe('A fungible asset.');
    expect(asset.signature).toContain('with issuer : Party; owner : Party; amount : Decimal');
    expect(asset.signature).toContain('signatory issuer, owner');
    expect(nodes.filter((n) => n.kind === 'field' && n.qualifiedName.startsWith('Token.Asset::Asset::')).map((n) => n.name))
      .toEqual(['issuer', 'owner', 'amount']);
  });

  it('extracts choices as public methods qualified Module::Choice, decorated with their consumption', () => {
    const { nodes } = extractFromSource('daml/Token/Asset.daml', ASSET);
    const transfer = find(nodes, 'method', 'Transfer');
    expect(transfer.qualifiedName).toBe('Token.Asset::Transfer');
    expect(transfer.decorators).toEqual(['choice', 'consuming']);
    expect(transfer.isExported).toBe(true);
    expect(transfer.visibility).toBe('public');
    expect(transfer.docstring).toBe('Propose a new owner.');
    expect(transfer.signature).toBe(
      'consuming choice Transfer : ContractId TransferProposal with newOwner : Party controller owner',
    );
    expect(find(nodes, 'method', 'Peek').decorators).toEqual(['choice', 'nonconsuming']);
  });

  it('records template clauses and choice bodies as references from their owner', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('daml/Token/Asset.daml', ASSET);
    expect(refsFrom(refs, find(nodes, 'class', 'Asset'), 'calls')).toContain('Token.Util::checkPositive');
    // `create T with ...` creates a contract: a call to the template, not a record construction.
    expect(refsFrom(refs, find(nodes, 'method', 'Transfer'), 'calls')).toContain('TransferProposal');
    expect(refsFrom(refs, find(nodes, 'method', 'Transfer'), 'instantiates')).toEqual([]);
    // `create asset with owner = ...` updates a template field's record: no template is named.
    expect(refsFrom(refs, find(nodes, 'method', 'Accept'), 'calls')).toEqual(['create']);
    expect(refsFrom(refs, find(nodes, 'method', 'Accept'), 'instantiates')).toEqual([]);
  });

  it('makes the template implement an interface instance, expanding the import alias', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('daml/Token/Asset.daml', ASSET);
    const asset = find(nodes, 'class', 'Asset');
    expect(refsFrom(refs, asset, 'implements')).toEqual(['Daml.Finance.Interface.Holding.V4.Holding::I']);
    const getAmount = find(nodes, 'method', 'getAmount');
    expect(getAmount.qualifiedName).toBe('Token.Asset::Asset::getAmount');
  });
});

describe('DAML interfaces and exceptions', () => {
  const code = `module Iface where

import Base qualified as B

-- | Something that can be locked.
interface Lockable requires B.Disclosure where
  viewtype View
  getLock : Optional Lock
  nonconsuming choice GetView : View
    with
      viewer : Party
    controller viewer
    do pure (view this)

exception InsufficientFunds
  with
    needed : Decimal
  where
    message "needed " <> show needed
`;

  it('extracts an interface with abstract module-level methods, its choices and requires', () => {
    const { nodes, unresolvedReferences: refs, errors } = extractFromSource('daml/Iface.daml', code);
    expect(errors).toEqual([]);
    const iface = find(nodes, 'interface', 'Lockable');
    expect(iface.signature).toBe('interface Lockable requires B.Disclosure viewtype View');
    expect(refsFrom(refs, iface, 'extends')).toEqual(['Base::Disclosure']);
    const getLock = find(nodes, 'method', 'getLock');
    expect(getLock.qualifiedName).toBe('Iface::getLock');
    expect(getLock.isAbstract).toBe(true);
    expect(find(nodes, 'method', 'GetView').decorators).toEqual(['choice', 'nonconsuming']);
  });

  it('extracts an exception as a class with its fields', () => {
    const { nodes } = extractFromSource('daml/Iface.daml', code);
    const exc = find(nodes, 'class', 'InsufficientFunds');
    expect(exc.decorators).toEqual(['exception']);
    expect(find(nodes, 'field', 'needed').qualifiedName).toBe('Iface::InsufficientFunds::needed');
  });
});

describe('DAML ledger actions', () => {
  const code = `module Test where

import Daml.Script
import Token.Asset
import Token.Asset qualified as A
import Lib.Holding qualified as H
import Other.Holding qualified as H

setup : Script ()
setup = script do
  alice <- allocateParty "Alice"
  cid <- submit alice do createCmd Asset with issuer = alice; owner = alice; amount = 1.0
  _ <- submit alice do exerciseCmd cid Transfer with newOwner = alice
  _ <- submit alice do exerciseCmd cid A.Peek
  _ <- submitExerciseInterfaceByKeyCmd alice (H.Lock with reason = "x")
  _ <- createAndExerciseCmd (Asset with issuer = alice; owner = alice; amount = 2.0) (Split 1.0)
  let fee = computeFee 1.0
  pure ()
`;

  it('links each exercise to its choice and each record construction to its type', () => {
    const { nodes, unresolvedReferences: refs, errors } = extractFromSource('daml/Test.daml', code);
    expect(errors).toEqual([]);
    const setup = find(nodes, 'function', 'setup');
    expect(refsFrom(refs, setup, 'calls')).toEqual(expect.arrayContaining([
      'Transfer', 'Token.Asset::Peek', 'Lib.Holding::Lock', 'Split', 'computeFee',
    ]));
    // An exercised choice argument is not also an instantiation; the created template is.
    expect(refsFrom(refs, setup, 'instantiates').sort()).toEqual(['Asset', 'Asset']);
  });

  it('lists every module an alias shared by several imports can stand for', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('daml/Test.daml', code);
    const lock = refs.find((r) => r.fromNodeId === find(nodes, 'function', 'setup').id && r.referenceName === 'Lib.Holding::Lock');
    expect(lock?.candidates).toEqual(['Lib.Holding::Lock', 'Other.Holding::Lock']);
  });

  it('attributes do-block statements and let values to the enclosing function, one reference per call', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('daml/Test.daml', code);
    expect(nodes.find((n) => n.name === 'fee')).toBeUndefined();
    const calls = refsFrom(refs, find(nodes, 'function', 'setup'), 'calls');
    expect(calls).toContain('allocateParty');
    expect(calls.filter((c) => c === 'computeFee')).toHaveLength(1);
    // A curried call `allocateParty "Alice"` yields its callee, never the partial application.
    expect(calls.some((c) => c.includes(' '))).toBe(false);
  });
});

const LEDGER = `module Settle.Batch where

import Settle.Instruction (Instruction(..))
import Iface.Account qualified as Account

template Batch
  with
    instructor : Party
    keys : [InstructionKey]
  where
    signatory instructor

    choice Settle : [ContractId Instruction]
      controller instructor
      do mapA settleOne keys

    choice Renew : ContractId Batch
      controller instructor
      do create this with keys = []

settleOne : InstructionKey -> Update (ContractId Instruction)
settleOne key = do
  (cid, instruction) <- fetchByKey @Instruction key
  account <- lookupByKey @Account.R instruction.accountKey
  archive cid
  pure cid

reopen : (HasFetch t) => ContractId t -> Update t
reopen cid = fetchFromInterface @t cid
`;

const GUARDS = `module Cal where

addDays : Int -> Int -> Int
addDays n d
  | n == 0 = d
  | n < 0 = addDays (n + 1) $ prevDay d
  | otherwise = addDays (n - 1) $ nextDay d

clamp : Int -> Int
clamp 0 = zero
clamp n
  | n > 10 = ceiling n
  | otherwise = floorOf n
  where
    ceiling m
      | m > 100 = cap m
      | otherwise = m

fees : Int -> Update Int
fees n = do
  let fee
        | n > 10 = bigFee n
        | otherwise = smallFee n
  pure fee
`;

describe('guarded right-hand sides', () => {
  for (const [language, path, source] of [
    ['DAML', 'daml/Cal.daml', GUARDS],
    ['Haskell', 'src/Cal.hs', GUARDS.replace(/ : /g, ' :: ')],
  ] as const) {
    it(`${language}: links the calls of every guard, not only the first`, () => {
      const { nodes, unresolvedReferences: refs } = extractFromSource(path, source);
      expect(refsFrom(refs, find(nodes, 'function', 'addDays'), 'calls')).toEqual(
        expect.arrayContaining(['addDays', 'prevDay', 'nextDay']),
      );
      // A later clause of the same function, and a guarded `where` helper.
      expect(refsFrom(refs, find(nodes, 'function', 'clamp'), 'calls')).toEqual(expect.arrayContaining(['floorOf']));
      expect(refsFrom(refs, find(nodes, 'function', 'ceiling'), 'calls')).toContain('cap');
      // A guarded `let` value runs in the enclosing function.
      expect(refsFrom(refs, find(nodes, 'function', 'fees'), 'calls')).toEqual(
        expect.arrayContaining(['bigFee', 'smallFee']),
      );
    });
  }
});

describe('DAML ledger actions on templates', () => {
  it('calls the template a by-key action names, and the template `create this` is written in', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('daml/Settle/Batch.daml', LEDGER);
    expect(refsFrom(refs, find(nodes, 'function', 'settleOne'), 'calls')).toEqual(expect.arrayContaining(['Instruction', 'Iface.Account::R']));
    expect(refsFrom(refs, find(nodes, 'method', 'Renew'), 'calls')).toContain('Settle.Batch::Batch');
    expect(refsFrom(refs, find(nodes, 'method', 'Renew'), 'instantiates')).toEqual([]);
    // A type variable names no template.
    expect(refsFrom(refs, find(nodes, 'function', 'reopen'), 'calls')).toEqual(['fetchFromInterface']);
  });
});

const VALUES = `module Pay where

import Pay.Util (Step(..), price)

total : [Step] -> Decimal
total steps = sum . map price $ filter isOpen steps
  where
    isOpen step = step.open

settle : Party -> [Step] -> Update [Step]
settle owner steps = do
  paid <- mapA (pay owner) steps
  let fee = feeOf owner
  forA_ paid \\s -> case s of
    Step{open} -> assertMsg "open" (open && fee > 0.0)
  pure $ map (.amount) paid

wild : Step -> Decimal
wild Step{..} = amount + bonus
`;

describe('DAML functions named as values', () => {
  it('calls a function composed, applied with `$`, or passed to another function', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('daml/Pay.daml', VALUES);
    const total = refsFrom(refs, find(nodes, 'function', 'total'), 'calls');
    expect(total).toEqual(expect.arrayContaining(['sum', 'map', 'price', 'filter', 'isOpen']));
  });

  it('does not reference what the code binds itself, field labels, selectors or import lists', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('daml/Pay.daml', VALUES);
    const settle = refsFrom(refs, find(nodes, 'function', 'settle'), 'calls');
    expect(settle).toEqual(expect.arrayContaining(['mapA', 'pay', 'feeOf', 'forA_', 'assertMsg', 'pure', 'map']));
    for (const bound of ['owner', 'steps', 'paid', 'fee', 's', 'open', 'amount']) expect(settle).not.toContain(bound);
    const module = nodes.find((n) => n.kind === 'namespace')!;
    expect(refsFrom(refs, module, 'calls')).toEqual([]);
    // A record wildcard binds names this file can't see.
    expect(refsFrom(refs, find(nodes, 'function', 'wild'), 'calls')).toEqual([]);
  });

  it('keeps the calls of a pattern binding and binds its variables', () => {
    const source = `module P where

f x = do
  let cid : ContractId T = coerceContractId (g x)
      (a, b) = split x
  h cid a b

k y = total + 1
  where
    (total, _) = split y
`;
    const { nodes, unresolvedReferences: refs } = extractFromSource('daml/P.daml', source);
    expect(refsFrom(refs, find(nodes, 'function', 'f'), 'calls').sort()).toEqual(['coerceContractId', 'g', 'h', 'split']);
    expect(refsFrom(refs, find(nodes, 'function', 'k'), 'calls')).toEqual(['split']);
  });

  it('treats template and choice fields and `this` as bound inside a template', () => {
    const { nodes, unresolvedReferences: refs } = extractFromSource('daml/Token/Asset.daml', ASSET);
    expect(refsFrom(refs, find(nodes, 'method', 'Peek'), 'calls')).toEqual(['pure']);
    expect(refsFrom(refs, find(nodes, 'method', 'Transfer'), 'calls').sort()).toEqual(['TransferProposal', 'create']);
  });
});
