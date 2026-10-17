const storageKey = 'codegraph.ui.quickStartDismissed';

function readDismissed(): boolean {
  try { return localStorage.getItem(storageKey) === '1'; }
  catch { return false; }
}

let dismissed = $state(readDismissed());

export const guide = {
  get dismissed() { return dismissed; },
  setDismissed(value: boolean) {
    dismissed = value;
    try { localStorage.setItem(storageKey, value ? '1' : '0'); }
    catch { /* 无法保存时，当前会话仍可关闭或重新打开引导。 */ }
  },
};
