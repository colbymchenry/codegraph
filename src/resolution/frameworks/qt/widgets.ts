import type { FrameworkExtractionResult, ResolutionContext, ResolvedRef, UnresolvedRef } from '../../types';

const qtWidgetsProjectPattern =
  /\b(QApplication|QWidget|QMainWindow|QDialog|QObject::connect|connect\s*\(\s*[^,]+,\s*(?:SIGNAL\s*\(|&[A-Za-z_][A-Za-z0-9_:]*::[A-Za-z_][A-Za-z0-9_]*|qOverload\s*<|QOverload\s*<|static_cast\s*<)|QT\s*\+=\s*widgets|find_package\s*\(\s*Qt[56]?\b[\s\S]*\bWidgets\b)/;

function isQtWidgetsDetectionFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  return (
    /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|pro|pri|cmake)$/i.test(basename) ||
    /^CMakeLists\.txt$/i.test(basename)
  );
}

export function detectQtWidgets(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => {
    if (!isQtWidgetsDetectionFile(filePath)) return false;
    const content = context.readFile(filePath);
    return Boolean(content && qtWidgetsProjectPattern.test(content));
  });
}

export function claimsQtWidgetsReference(_name: string, ref?: UnresolvedRef): boolean {
  if (!ref || ref.language === 'qml') return false;
  return false;
}

export function resolveQtWidgets(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
  return null;
}

export function extractQtWidgets(_filePath: string, _content: string): FrameworkExtractionResult {
  return { nodes: [], references: [] };
}
