import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

// `Logger.log()` must bind to Logger's own `log`, not to the first method in
// the file whose owner's name merely CONTAINS "Logger" (`FileLogger::log`).
// The method lookup matched the class name as a substring of the qualified
// name, so a class declared earlier in the same file with a longer name
// ending in the receiver's won every call.

let dir: string;
let cg: CodeGraph;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-owner-class-'));
  fs.writeFileSync(path.join(dir, 'log.py'), `class FileLogger:
    def log(self):
        pass

class Logger:
    def log(self):
        pass

def via_class():
    Logger.log()

def via_instance(logger):
    logger.log()
`);
  fs.writeFileSync(path.join(dir, 'log.ts'), `export class FileLogger {
  static log(): void {}
}

export class Logger {
  static log(): void {}
}

export function viaStatic(): void {
  Logger.log();
}
`);
  // A same-named NESTED class must not take a call that names the top-level
  // class — whether it is declared first, or is the only one with the method.
  fs.writeFileSync(path.join(dir, 'nested.py'), `class Outer:
    class Logger:
        def log(self):
            pass

class Logger:
    def log(self):
        pass

def nested_first():
    Logger.log()
`);
  fs.writeFileSync(path.join(dir, 'nested_only.py'), `class Plain:
    pass

class Box:
    class Plain:
        def log(self):
            pass

def top_has_none():
    Plain.log()
`);
  // R allows dots in a class name: the owner is `Bank.Account`, whole.
  fs.writeFileSync(path.join(dir, 'account.R'), `Bank.Account <- R6::R6Class("Bank.Account",
  public = list(
    deposit = function(x) { x }
  )
)
`);
  fs.writeFileSync(path.join(dir, 'main.R'), `BankAccount <- R6::R6Class("BankAccount",
  public = list(
    deposit = function(x) { x }
  )
)

run_it <- function() {
  Bank.Account$deposit(1)
}
`);
  cg = await CodeGraph.init(dir, { index: true });
});

afterAll(() => {
  cg?.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** `file#qualifiedName` of every callee — the file matters: several fixtures share names. */
function calleesOf(name: string, file: string): string[] {
  const fn = cg.getNodesByName(name).find((n) => n.kind === 'function' && n.filePath === file);
  expect(fn).toBeDefined();
  return cg.getCallees(fn!.id).map(({ node }) => `${node.filePath}#${node.qualifiedName}`);
}

describe('method call binds to the receiver class itself, not a class whose name contains it', () => {
  it('Python: Logger.log() → Logger::log', () => {
    const callees = calleesOf('via_class', 'log.py');
    expect(callees).toContain('log.py#Logger::log');
    expect(callees).not.toContain('log.py#FileLogger::log');
  });

  it('Python: logger.log() (capitalized receiver) → Logger::log', () => {
    const callees = calleesOf('via_instance', 'log.py');
    expect(callees).toContain('log.py#Logger::log');
    expect(callees).not.toContain('log.py#FileLogger::log');
  });

  it('TypeScript: Logger.log() → Logger::log', () => {
    const callees = calleesOf('viaStatic', 'log.ts');
    expect(callees).toContain('log.ts#Logger::log');
    expect(callees).not.toContain('log.ts#FileLogger::log');
  });

  it('R: a dotted class name is the owner as a whole', () => {
    const callees = calleesOf('run_it', 'main.R');
    expect(callees).toContain('account.R#Bank.Account::deposit');
    expect(callees).not.toContain('main.R#BankAccount::deposit');
  });

  // Known limitation (see findOwnMethod): a same-named NESTED class can take a
  // call that names the top-level class. Pinned with it.fails so a fix flips
  // them; the "fixture indexed" checks keep a broken fixture from passing as
  // the expected failure.
  it('Python nested-class fixtures are indexed and resolved', () => {
    expect(calleesOf('top_has_none', 'nested_only.py').length).toBeGreaterThan(0);
    expect(calleesOf('nested_first', 'nested.py').length).toBeGreaterThan(0);
  });
  it.fails("Python: a nested class's method is not the top-level class's own", () => {
    expect(calleesOf('top_has_none', 'nested_only.py')).not.toContain('nested_only.py#Box::Plain::log');
  });
  it.fails('Python: a nested class declared first does not take a top-level call', () => {
    const callees = calleesOf('nested_first', 'nested.py');
    expect(callees).toContain('nested.py#Logger::log');
    expect(callees).not.toContain('nested.py#Outer::Logger::log');
  });
});
