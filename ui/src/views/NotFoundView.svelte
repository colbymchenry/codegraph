<script lang="ts">
  import { t } from '../lib/locale.svelte';

  interface Props {
    path: string;
  }
  let { path }: Props = $props();
</script>

<div class="scroll">
  <div class="emptystate">
    <h2>{t('notfound.title')}</h2>
    <p>
      <span class="mono">#{path}</span>
      {t('notfound.mid')}
      <a class="mono link" href="#/">{t('notfound.start')}</a>
    </p>
  </div>
</div>

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }

  .link {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-color: var(--accent-line);
    text-underline-offset: 3px;
  }
</style>
