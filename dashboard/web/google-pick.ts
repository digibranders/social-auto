import { button, h } from './ui.ts';

export interface PickResult {
  kind: 'ok' | 'warn';
  text: string;
}

interface Location {
  id: string;
  title: string;
}

const messageOf = (body: unknown): string | null =>
  typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null;

/** The locations of locations() answers, or null when the answer is not that shape. */
export function parseLocations(body: unknown): Location[] | null {
  const list = (body as { locations?: unknown } | null)?.locations;
  if (!Array.isArray(list)) return null;
  const found: Location[] = [];
  for (const item of list) {
    const { id, title } = (item ?? {}) as { id?: unknown; title?: unknown };
    if (typeof id !== 'string' || typeof title !== 'string') return null;
    found.push({ id, title });
  }
  return found;
}

/**
 * Shown after Google found several business locations on the signed-in account: the person chooses the one that
 * belongs to this client. The waiting token stays in a hidden cookie; only the choice is sent.
 */
export function googleLocationPicker(finish: (result: PickResult) => void, close: () => void): HTMLElement {
  const list = h('div', { class: 'options' }, h('p', { class: 'muted' }, 'Looking up the locations…'));
  const problem = h('p', { class: 'note', hidden: '' });

  const fail = (text: string): void => {
    problem.textContent = text;
    problem.hidden = false;
  };

  const choose = async (location: Location, buttons: HTMLButtonElement[]): Promise<void> => {
    buttons.forEach((b) => (b.disabled = true));
    problem.hidden = true;
    try {
      const response = await fetch(`/api/google-pick?location=${encodeURIComponent(location.id)}`, { method: 'POST', credentials: 'same-origin' });
      if (response.status === 401) return void toLogin();
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(messageOf(body) ?? `Could not save (${response.status}).`);
      close();
      finish({ kind: 'ok', text: `Google connected: ${location.title}. Posts from now on will also go there as updates.` });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      buttons.forEach((b) => (b.disabled = false));
    }
  };

  void (async () => {
    try {
      const response = await fetch('/api/google-pick', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) return void toLogin();
      const body: unknown = await response.json().catch(() => null);
      const locations = response.ok ? parseLocations(body) : null;
      if (!locations) throw new Error(messageOf(body) ?? `Could not load the locations (${response.status}).`);
      if (locations.length === 0) throw new Error('This Google account manages no locations.');
      const buttons: HTMLButtonElement[] = [];
      for (const location of locations) {
        const option = button([h('span', { class: 'option-text' }, h('b', {}, location.title))], 'option', () => void choose(location, buttons));
        buttons.push(option);
      }
      list.replaceChildren(...buttons);
    } catch (error) {
      list.replaceChildren();
      fail(error instanceof Error ? error.message : String(error));
    }
  })();

  return h(
    'div',
    { class: 'dialog-inner' },
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Which listing is this client’s?'), button('Close', 'btn btn-quiet', close)),
    h('p', { class: 'muted' }, 'This Google account manages several business locations. Choose the one that belongs to this client.'),
    list,
    problem,
  );
}

function toLogin(): void {
  window.location.replace('/login');
}
