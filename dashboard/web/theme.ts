/** Dark by default, with a light option that is remembered on this browser. */

export type Theme = 'dark' | 'light';

const THEME_KEY = 'calendar.theme';

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function show(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function setTheme(theme: Theme): void {
  show(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Remembering the choice is a convenience; the page works without it.
  }
}

export function applyStoredTheme(): void {
  try {
    if (localStorage.getItem(THEME_KEY) === 'light') show('light');
  } catch {
    // Storage can be unavailable (private windows); stay on the default.
  }
}
