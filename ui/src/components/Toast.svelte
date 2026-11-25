<!--
  The bottom-centre note. Ink fill, paper text, 2.6 s (design spec §appendix).

  `aria-live="polite"` rather than `alert`: the screen has already refreshed by
  the time this appears, so it is a confirmation, not something to interrupt for.
-->
<script lang="ts">
  import { toast } from '../lib/toast.svelte';
</script>

<div class="live-region" aria-live="polite">
  {#if toast.message}
    <div class="toast">{toast.message}</div>
  {/if}
</div>

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    background: var(--ink);
    color: var(--paper);
    padding: 8px 14px;
    font-size: 12.5px;
    line-height: 1.4;
    max-width: 70ch;
    z-index: 50;
    animation: rise 140ms ease-out;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
