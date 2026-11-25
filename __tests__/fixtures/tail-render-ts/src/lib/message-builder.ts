import type { AttachedFile, SelectedElementRef } from './session-store';

export interface BuiltMessage {
	id: string;
	text: string;
	attachments: number;
}

/** Render the selected canvas elements as a fenced block above the prose. */
export function renderElementBlock(elements: SelectedElementRef[]): string {
	if (elements.length === 0) return '';
	const lines = elements.map((e) => `- ${e.kind}: ${e.label} (${e.id})`);
	return ['```elements', ...lines, '```'].join('\n');
}

export function formatStylesBlock(files: AttachedFile[]): string {
	return files.map((f) => `${f.path} (${f.mime}, ${f.bytes}b)`).join('\n');
}

export function buildMessage(
	content: string,
	files: AttachedFile[],
	elements: SelectedElementRef[],
): BuiltMessage {
	const block = renderElementBlock(elements);
	const styles = formatStylesBlock(files);
	return {
		id: `m-${content.length}-${files.length}`,
		text: [block, styles, content].filter(Boolean).join('\n\n'),
		attachments: files.length,
	};
}
