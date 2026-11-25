/**
 * Swift's extractor keeps one receiver level, so `super.reset()`,
 * `axis.entries.removeAll()` and `min(a, b)` reach the resolver as bare
 * names. How the call is written decides what it can mean:
 *
 * - bare or through `self.`: a member of a type around the call or of what it
 *   inherits or conforms to (UIKit ancestry and the standard collection
 *   protocols included), the nearest first — `super.`: the latter only.
 *   Charts' `min(a, b)` went to a range type's `min` field, `max(a, b)` to a
 *   `Sequence` extension, `super.init(…)` to an Objective-C demo's `init`;
 * - down a longer chain, a name the standard types all carry is theirs unless
 *   the receiver names the owner or the call gives a label only the project's
 *   method takes (Kingfisher's `data.kf.contains(jpeg:)`);
 * - a global `let` in a playground is nobody else's call target.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-shape-'));
  const files: Record<string, string> = {
    'Sources/Charts/Utils/Sequence+KeyPath.swift': `extension Sequence {
    func max<T: Comparable>(by keyPath: KeyPath<Element, T>) -> Element? {
        return nil
    }
}
`,
    'Sources/Charts/Renderers/Renderer.swift': `open class Renderer {
    public struct XBounds {
        public var min: Int = 0
    }
}
`,
    'Sources/Charts/Data/ChartData.swift': `open class ChartData {
    open func removeAll() { }
}
`,
    'Sources/Charts/Formatters/Formatter.swift': `open class Formatter {
    open func reset() { }
}
`,
    'Sources/Charts/Charts/ChartViewBase.swift': `open class ChartViewBase: NSObject {
    open func highlightValue(_ h: Int) { }
    open func reset() { }
}
`,
    'Sources/Charts/Charts/BarChartView.swift': `open class BarChartView: ChartViewBase {
    open override func highlightValue(_ h: Int) { }
}
`,
    'Sources/Charts/Charts/BarLineChartViewBase.swift': `open class BarLineChartViewBase: ChartViewBase {
    open func tapped(axis: Axis) {
        highlightValue(1)
        let widest = max(1, 2)
        let narrowest = min(3, 4)
        super.reset()
        axis.entries.removeAll()
    }
}
`,
    'Sources/Charts/Wrapper/KingfisherWrapper.swift': `public struct KingfisherWrapper<Base> {
    public let base: Base
}

extension KingfisherWrapper where Base == Data {
    func contains(jpeg marker: Int) -> Bool {
        return false
    }
}
`,
    'Sources/Charts/Wrapper/Decoder.swift': `final class Decoder {
    func scan(data: Data) -> Bool {
        return data.kf.contains(jpeg: 0xC2)
    }
}
`,
    'Demo/Extensions/UIViewController+Bar.swift': `extension UIViewController {
    func setupOperationBar() { }
}
`,
    'Demo/Controllers/ListController.swift': `class ListController: UICollectionViewController {
    override func viewDidLoad() {
        setupOperationBar()
    }
}
`,
    'Demo/Chart.playground/Contents.swift': `let min = 20.0
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('Swift calls reached by name alone', () => {
  it('reach the nearest inherited member, and nothing outside the hierarchy', () => {
    expect(callsFrom('Sources/Charts/Charts/BarLineChartViewBase.swift')).toEqual([
      'ChartViewBase::highlightValue',
      'ChartViewBase::reset',
    ]);
  });

  it('keep a standard-named method the call labels as the project’s', () => {
    expect(callsFrom('Sources/Charts/Wrapper/Decoder.swift')).toEqual(['KingfisherWrapper::contains']);
  });

  it('reach an extension of a UIKit ancestor', () => {
    expect(callsFrom('Demo/Controllers/ListController.swift')).toEqual(['UIViewController::setupOperationBar']);
  });
});
