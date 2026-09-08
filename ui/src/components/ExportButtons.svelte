<!--
  Take the picture with you (design spec §3.9).

  Two buttons, because there are exactly two destinations: a PR comment, which
  wants a PNG on the clipboard, and a README, which wants an SVG on disk. Both
  render the light theme whatever the viewer is set to — an image is read on
  somebody else's screen, and a dark strip on GitHub's white comment background
  reads as a mistake rather than a preference.

  The SVG is built lazily, at click time, from the layout the canvas is already
  drawing. Nothing is measured, nothing is scraped, and the button costs nothing
  until it is pressed.
-->
<script lang="ts">
  import { copyPngToClipboard, downloadSvg, svgToPng, PNG_SCALE } from '../lib/export-image';
  import { toast } from '../lib/toast.svelte';

  interface Props {
    /** Builds the SVG at a given device-pixel scale. */
    build: (scale: number) => string;
    /** File stem for the download, without an extension. */
    filename: string;
    disabled?: boolean;
  }

  let { build, filename, disabled = false }: Props = $props();
  let busy = $state(false);

  async function copyImage(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const where = await copyPngToClipboard(
        () => svgToPng(build(PNG_SCALE)),
        `${filename}.png`
      );
      toast.show(
        where === 'copied'
          ? 'Image copied · paste it into a comment'
          : 'Clipboard unavailable · image saved instead'
      );
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'The image could not be made.');
    } finally {
      busy = false;
    }
  }

  function saveSvg(): void {
    try {
      downloadSvg(build(1), `${filename}.svg`);
      toast.show('SVG saved');
    } catch (error) {
      toast.show(error instanceof Error ? error.message : 'The file could not be saved.');
    }
  }
</script>

<div class="exp">
  <button type="button" onclick={copyImage} disabled={disabled || busy}>
    {busy ? 'Rendering…' : 'Copy image'}
  </button>
  <button type="button" onclick={saveSvg} {disabled}>Download SVG</button>
</div>

<style>
  .exp {
    display: flex;
    flex: 0 0 auto;
    /* Pushed to the trailing edge of a flex header; inert in a block panel. */
    margin-left: auto;
    gap: 6px;
  }

  .exp button {
    padding: 3px 8px;
    background: var(--paper-2);
    border: 1px solid var(--rule-soft);
    border-radius: 0;
    color: var(--ink-2);
    cursor: pointer;
    font: 12.5px var(--sans);
    white-space: nowrap;
  }

  .exp button:hover:not(:disabled) {
    background: var(--press);
    border-color: var(--ink-3);
    color: var(--ink);
  }

  .exp button:disabled {
    color: var(--ink-4);
    cursor: default;
  }

  .exp button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
