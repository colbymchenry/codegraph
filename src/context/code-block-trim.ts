export function trimCodeBlockMiddle(code: string, maxLength: number): string {
  if (code.length <= maxLength) {
    return code;
  }

  const marker = '\n... (truncated middle) ...\n';
  if (maxLength <= marker.length + 20) {
    return code.slice(0, maxLength) + '\n... (truncated) ...';
  }

  const available = maxLength - marker.length;
  const headTarget = Math.floor(available / 2);
  const tailTarget = available - headTarget;
  const head = sliceHeadAtLineBoundary(code, headTarget);
  const tail = sliceTailAtLineBoundary(code, tailTarget);
  return head.replace(/\n+$/, '') + marker + tail.replace(/^\n+/, '');
}

function sliceHeadAtLineBoundary(code: string, maxChars: number): string {
  const head = code.slice(0, maxChars);
  const lineEnd = head.lastIndexOf('\n');
  return lineEnd > maxChars * 0.5 ? head.slice(0, lineEnd) : head;
}

function sliceTailAtLineBoundary(code: string, maxChars: number): string {
  const tail = code.slice(Math.max(0, code.length - maxChars));
  const lineStart = tail.indexOf('\n');
  return lineStart >= 0 && lineStart < maxChars * 0.5 ? tail.slice(lineStart + 1) : tail;
}
