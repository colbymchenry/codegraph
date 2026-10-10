export type UiTheme = 'auto' | 'light' | 'dark';

const storageKey = 'codegraph.ui.theme';

function isUiTheme(value: string | null): value is UiTheme {
  return value === 'auto' || value === 'light' || value === 'dark';
}

function readTheme(): UiTheme {
  try {
    const saved = localStorage.getItem(storageKey);
    return isUiTheme(saved) ? saved : 'auto';
  } catch {
    return 'auto';
  }
}

function applyTheme(theme: UiTheme): void {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    return;
  }
  document.documentElement.dataset.theme = theme;
}

const initialTheme = readTheme();
let current = $state<UiTheme>(initialTheme);
applyTheme(initialTheme);

export const themePreference = {
  get current(): UiTheme {
    return current;
  },
  setTheme(next: UiTheme): void {
    current = next;
    applyTheme(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // 当前会话已经切换，存储失败不应阻断主题反馈。
    }
  },
};
