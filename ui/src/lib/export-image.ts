/**
 * Getting an SVG string out of the browser: as a PNG on the clipboard, or as a
 * file on disk.
 *
 * `export-svg.ts` does the drawing and has no browser in it at all; everything
 * that needs a `document` is here, and it is deliberately thin — a canvas, an
 * `<img>`, and two ways of handing the result over.
 *
 * ## Why an `<img>` and not `foreignObject`
 *
 * A canvas rasterises an SVG by loading it as an image, which is a strictly
 * sandboxed context: no scripts, no network, and **no webfonts**. That is why
 * the export draws real `<text>` in a font *stack* rather than embedding
 * anything — the raster falls back to the platform's own monospace, which
 * advances at the same ~0.6em, so the code grid survives. It is also why the
 * canvas is never tainted and `toBlob` works: nothing external is referenced.
 *
 * The scale trick matters. The SVG is asked for at `scale`, which multiplies
 * only the root `width`/`height` while the `viewBox` stays in CSS pixels — so
 * the image's *intrinsic* size is already 2x and `drawImage` copies it 1:1
 * instead of upscaling a 1x bitmap. Text comes out rasterised at 2x, not blurry.
 */

/** Device-pixel multiplier for the PNG (design spec §3.9). */
export const PNG_SCALE = 2;

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The SVG's own root width/height, which the raster canvas has to match. */
export function svgPixelSize(svg: string): { width: number; height: number } {
  const width = Number(/\bwidth="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 0);
  const height = Number(/\bheight="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 0);
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be rendered.'));
    img.src = url;
  });
}

/** Rasterise an already-scaled SVG string to a PNG blob. */
export async function svgToPng(svg: string): Promise<Blob> {
  const { width, height } = svgPixelSize(svg);
  const img = await loadImage(svgDataUrl(svg));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('This browser would not give up a 2D canvas.');
  ctx.drawImage(img, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      'image/png'
    );
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick: Safari has not finished with the URL when click()
  // returns, and a revoked object URL downloads a zero-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadSvg(svg: string, filename: string): void {
  downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), filename);
}

/**
 * Put a PNG on the clipboard, falling back to a download.
 *
 * `ClipboardItem` is constructed with the *promise*, not the awaited blob:
 * Safari discards the user gesture across an `await`, and a copy that silently
 * does nothing is the worst outcome of the three. Returns what actually
 * happened so the caller can say so rather than claim a copy it did not make.
 */
export async function copyPngToClipboard(
  render: () => Promise<Blob>,
  filename: string
): Promise<'copied' | 'downloaded'> {
  const write = navigator.clipboard?.write;
  if (typeof write === 'function' && typeof ClipboardItem === 'function') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': render() })]);
      return 'copied';
    } catch {
      // Denied permission, an unfocused document, or a browser that will not
      // take a promise. Fall through — the reader still gets their image.
    }
  }
  downloadBlob(await render(), filename);
  return 'downloaded';
}
