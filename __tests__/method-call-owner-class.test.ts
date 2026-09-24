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

function calleesOf(name: string, file: string): string[] {
  const fn = cg.getNodesByName(name).find((n) => n.kind === 'function' && n.filePath === file);
  expect(fn).toBeDefined();
  return cg.getCallees(fn!.id).map(({ node }) => node.qualifiedName);
}

describe('method call binds to the receiver class itself, not a class whose name contains it', () => {
  it('Python: Logger.log() → Logger::log', () => {
    const callees = calleesOf('via_class', 'log.py');
    expect(callees).toContain('Logger::log');
    expect(callees).not.toContain('FileLogger::log');
  });

  it('Python: logger.log() (capitalized receiver) → Logger::log', () => {
    const callees = calleesOf('via_instance', 'log.py');
    expect(callees).toContain('Logger::log');
    expect(callees).not.toContain('FileLogger::log');
  });

  it('TypeScript: Logger.log() → Logger::log', () => {
    const callees = calleesOf('viaStatic', 'log.ts');
    expect(callees).toContain('Logger::log');
    expect(callees).not.toContain('FileLogger::log');
  });

  it('R: a dotted class name is the owner as a whole', () => {
    const callees = calleesOf('run_it', 'main.R');
    expect(callees).toContain('Bank.Account::deposit');
    expect(callees).not.toContain('BankAccount::deposit');
  });
});
