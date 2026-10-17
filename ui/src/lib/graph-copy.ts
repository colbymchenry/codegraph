import { i18n } from './i18n.svelte';
export function graphText(zh: string, en: string): string {
  return i18n.locale === 'zh-CN' ? zh : en;
}
