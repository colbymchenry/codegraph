import type { FrameworkExtractionResult, ResolutionContext } from '../../types';

export function detectQtUiFiles(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => /\.ui$/i.test(filePath));
}

export function extractQtUiXml(_filePath: string, _content: string): FrameworkExtractionResult {
  return { nodes: [], references: [] };
}
