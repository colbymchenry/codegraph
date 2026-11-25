/**
 * A Kotlin receiver chain stops at a type the project doesn't declare, so a call
 * through `uiState.value` on a `StateFlow<UiState>` linked nothing, though what
 * `.value` holds is written in the declaration. Holders whose member is their
 * type argument are read through; any other library type still stops the chain.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

const FILES: Record<string, string> = {
  'src/Vm.kt': `package demo

import kotlinx.coroutines.flow.StateFlow

sealed interface UiState {
    fun shouldKeep(): Boolean = true
}

class Other {
    fun shouldKeep(): Boolean = false
    fun left(): Int = 1
    fun right(): Int = 2
}

class Decoy {
    fun left(): Int = 3
    fun right(): Int = 4
}

class Vm(val uiState: StateFlow<UiState>) {
    val pair: Pair<Other, Decoy> = Pair(Other(), Decoy())
    val lazily: Lazy<Other> = lazy { Other() }
    val box: Library<Other> = Library()
}
`,
  'src/Main.kt': `package demo

class Main(val viewModel: Vm, val flow: kotlinx.coroutines.flow.MutableStateFlow<Other>) {
    fun fromParameter() {
        viewModel.uiState.value.shouldKeep()
    }

    fun first() {
        viewModel.pair.first.left()
    }

    fun second() {
        viewModel.pair.second.right()
    }

    fun lazily() {
        viewModel.lazily.value.left()
    }

    fun ownProperty() {
        flow.value.left()
    }

    fun library() {
        viewModel.box.value.left()
    }

    fun notAMember() {
        viewModel.pair.third.left()
    }
}
`,
};

describe('a Kotlin chain reads through a holder of its type argument', () => {
  let dir: string;
  let cg: CodeGraph;

  const calls = (name: string): string[] => {
    const from = cg.getNodesByKind('method').find((n: Node) => n.name === name && n.filePath === 'src/Main.kt');
    expect(from, name).toBeDefined();
    return cg.getOutgoingEdges(from!.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.qualifiedName).sort();
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kt-holder-'));
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

  it('reads a flow\'s value as its type argument', () => {
    expect(calls('fromParameter')).toEqual(['demo::UiState::shouldKeep']);
    expect(calls('ownProperty')).toEqual(['demo::Other::left']);
  });

  it('reads each member of a pair as its own type argument', () => {
    expect(calls('first')).toEqual(['demo::Other::left']);
    expect(calls('second')).toEqual(['demo::Decoy::right']);
  });

  it('reads a `Lazy` written as the type', () => {
    expect(calls('lazily')).toEqual(['demo::Other::left']);
  });

  it('stops at a library type it knows nothing of, and at a member a holder lacks', () => {
    expect(calls('library')).toEqual([]);
    expect(calls('notAMember')).toEqual([]);
  });
});
